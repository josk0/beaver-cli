import type { CliIO } from '../cli.js';
import { connect } from '../client/http.js';
import { BeaverError, EXIT_CODES } from '../core/errors.js';
import { scriptPolicy } from '../core/policy.js';
import { ChatSession, type AskOptions, type AskResult } from '../core/session.js';
import { emptyAskResult, errorInfo, formatAnswer, reportSideEffects, writeError, writeJson } from './output.js';

export interface PrintOptions {
  /** The prompt; undefined reads it from stdin. */
  prompt?: string;
  json: boolean;
  thread: AskOptions['thread'];
  items: Array<{ library_ref: string; zotero_key: string }>;
  timeoutMs: number;
  port: number;
  windowId?: string;
  /** Poll interval; the default of the session applies when unset. */
  pollMs?: number;
}

/**
 * Reads all of stdin. On abort it lets go of the stream (listeners removed, stream destroyed), so the
 * process can exit while the producer keeps the pipe open.
 */
function readStdin(io: CliIO, port: number): Promise<string> {
  const stdin = io.stdin as NodeJS.ReadableStream & { destroy?: () => void };
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (e: unknown) => settle(() => reject(e));
    const onAbort = () => {
      settle(() => reject(new BeaverError('stopped', 'Cancelled while reading the prompt.', { port })));
      stdin.pause();
      stdin.destroy?.();
    };
    const settle = (finish: () => void) => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      io.signal?.removeEventListener('abort', onAbort);
      finish();
    };
    if (io.signal?.aborted) return onAbort();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    io.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function resolvePrompt(opts: PrintOptions, io: CliIO): Promise<string> {
  const ctx = { port: opts.port };
  if (opts.prompt === undefined) {
    if (io.stdin.isTTY) {
      throw new BeaverError('usage', 'No prompt: give it after -p, or pipe it to stdin.', ctx);
    }
    // Only here is stdin read: with a prompt argument an open pipe must not hang the call.
    const text = (await readStdin(io, opts.port)).trim();
    if (text === '') throw new BeaverError('usage', 'The prompt from stdin is empty.', ctx);
    return text;
  }
  if (opts.prompt.trim() === '') throw new BeaverError('usage', 'The prompt is empty.', ctx);
  return opts.prompt;
}

function emit(result: AskResult, json: boolean, io: CliIO): number {
  if (json) {
    writeJson(io, { ...result });
  } else {
    const out = formatAnswer(result);
    if (out) io.stdout.write(`${out}\n`);
    if (result.thread_id) io.stderr.write(`Chat: ${result.thread_id}\n`);
    reportSideEffects(io, result);
    if (result.error) writeError(io, result.error);
  }
  return result.error ? EXIT_CODES[result.error.code] : 0;
}

/** Script mode: one question, one complete result. Never prompts; never throws. */
export async function runPrint(opts: PrintOptions, io: CliIO): Promise<number> {
  try {
    const text = await resolvePrompt(opts, io);
    // The signal goes to `ask` only: an aborted client could not send the stop.
    const { client } = await connect({ port: opts.port, windowId: opts.windowId });
    const session = new ChatSession(client, { port: opts.port });
    const result = await session.ask({
      thread: opts.thread,
      text,
      items: opts.items.length > 0 ? opts.items : undefined,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      policy: scriptPolicy,
      signal: io.signal,
    });
    return emit(result, opts.json, io);
  } catch (e) {
    return emit(emptyAskResult(errorInfo(e, opts.port)), opts.json, io);
  }
}
