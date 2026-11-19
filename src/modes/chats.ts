import type { CliIO } from '../cli.js';
import { BeaverClient, connect, MAX_THREADS, validThreadLimit } from '../client/http.js';
import type { ApplyResult, ThreadRow } from '../client/types.js';
import { BeaverError, EXIT_CODES } from '../core/errors.js';
import { ChatSession } from '../core/session.js';
import { errorInfo, writeError, writeJson, type ErrorInfo } from './output.js';

/** "2026-11-19 10:30" in this computer's time zone; the text as given when it is not a time. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One numbered line per chat: number, name, last update (local time), id. */
export function formatThreadList(rows: ThreadRow[]): string {
  const width = String(rows.length).length;
  return rows
    .map((t, i) => {
      const when = typeof t.updated_at === 'string' ? localTime(t.updated_at) : '';
      return `${String(i + 1).padStart(width)}. ${t.name?.trim() || '(untitled)'}  ${when}  ${t.id}`;
    })
    .join('\n');
}

/** `beaver threads [query]`: saved chats, most recently updated first. */
export async function runThreads(
  opts: { port: number; query?: string; limit?: number; after?: string; json: boolean },
  io: CliIO,
): Promise<number> {
  let rows: ThreadRow[] = [];
  let more = false;
  let cursor: string | null = null;
  let error: ErrorInfo | null = null;
  try {
    // Listing chats needs no window; `info` still checks the interface version.
    const client = new BeaverClient({ port: opts.port });
    if (opts.limit !== undefined && !validThreadLimit(opts.limit)) {
      throw new BeaverError('usage', `--limit must be a whole number from 1 to ${MAX_THREADS}.`, { port: opts.port });
    }
    await client.info();
    const page = await new ChatSession(client, { port: opts.port }).threads(opts.query, opts.limit, opts.after);
    rows = page.threads;
    more = page.has_more;
    cursor = page.has_more && typeof page.next_cursor === 'string' ? page.next_cursor : null;
  } catch (e) {
    error = errorInfo(e, opts.port);
  }
  if (opts.json) {
    writeJson(io, {
      threads: rows.map((t) => ({ id: t.id, name: t.name, created_at: t.created_at, updated_at: t.updated_at, pinned: t.pinned })),
      has_more: more,
      next_cursor: cursor,
      error,
    });
  } else {
    if (rows.length > 0) io.stdout.write(`${formatThreadList(rows)}\n`);
    else if (!error) io.stdout.write(opts.query ? 'No saved chat matches.\n' : 'No saved chats.\n');
    if (cursor) {
      const again = [opts.query ? JSON.stringify(opts.query) : '', opts.limit !== undefined ? `--limit ${opts.limit}` : '', `--after ${cursor}`];
      io.stdout.write(`More: beaver threads ${again.filter(Boolean).join(' ')}\n`);
    }
    if (error) writeError(io, error);
  }
  return error ? EXIT_CODES[error.code] : 0;
}

/** `beaver apply <action-id> -r <thread-id>`: applies a declined or undecided change of a saved chat. */
export async function runApply(
  opts: { port: number; windowId?: string; threadId: string; actionId: string; json: boolean },
  io: CliIO,
): Promise<number> {
  let result: ApplyResult = { applied: [], failed: [] };
  let error: ErrorInfo | null = null;
  try {
    const { client } = await connect({ port: opts.port, windowId: opts.windowId });
    result = await new ChatSession(client, { port: opts.port }).apply(opts.threadId, opts.actionId);
    if (result.applied.length === 0 && result.failed.length > 0) {
      const why = result.failed.map((f) => `${f.action_id}: ${typeof f.error === 'string' ? f.error : JSON.stringify(f.error)}`).join('; ');
      throw new BeaverError('run_error', `The change could not be applied (${why}).`, { port: opts.port });
    }
  } catch (e) {
    error = errorInfo(e, opts.port);
  }
  if (opts.json) {
    writeJson(io, { thread_id: opts.threadId, applied: result.applied, failed: result.failed, error });
  } else {
    for (const id of result.applied) io.stdout.write(`Applied: ${id}\n`);
    if (!error) {
      for (const f of result.failed) io.stderr.write(`beaver: not applied: ${f.action_id} (${typeof f.error === 'string' ? f.error : JSON.stringify(f.error)})\n`);
    }
    if (error) writeError(io, error);
  }
  return error ? EXIT_CODES[error.code] : 0;
}
