import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunStatus, ThreadRow } from '../../src/client/types.js';

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Accept the request and never answer (for timeout tests). */
  hang?: boolean;
}

/** Keyed by route name: the last path segment, e.g. 'info', 'status'. */
export type FakeHandler = (body: any, callIndex: number) => FakeReply | Promise<FakeReply>;

export interface FakeBeaver {
  port: number;
  calls: Array<{ route: string; body: any }>;
  close(): Promise<void>;
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** In-process stand-in for Zotero's local server, on a free port. A route without a handler answers 404 like a missing endpoint. */
export async function startFakeBeaver(handlers: Record<string, FakeHandler>): Promise<FakeBeaver> {
  const calls: FakeBeaver['calls'] = [];
  const counts = new Map<string, number>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req);
    const route = (req.url ?? '').split('?')[0].split('/').filter(Boolean).pop() ?? '';
    const handler = req.method === 'POST' ? handlers[route] : undefined;
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No endpoint found\n');
      return;
    }
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { __unparsed: text };
    }
    calls.push({ route, body });
    const index = counts.get(route) ?? 0;
    counts.set(route, index + 1);
    const reply = await handler(body, index);
    if (reply.hang) return;
    const status = reply.status ?? 200;
    if (reply.json !== undefined) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    } else {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(reply.text ?? '');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// A simulated Beaver with chats and runs, answering the /beaver/chat/* routes.

export const WIN = 'main-test-1';
/** The id a new chat gets in the simulation. */
export const NEW_T = 'a1111111-1111-4111-8111-111111111111';

const RAW = Symbol('raw');
/** A full FakeReply (status, text, hang) where a JSON body is expected. */
export interface RawReply {
  readonly [RAW]: FakeReply;
}
export function raw(reply: FakeReply): RawReply {
  return { [RAW]: reply };
}

/** A refusal in the shape of the chat routes. */
export function refusal(code: string, status: number, message = `refused: ${code}`): RawReply {
  return raw({ status, json: { ok: false, code, message } });
}

/** A value, `raw(reply)`, or a function of the request body (and call index) returning either. */
export type Scripted = unknown;

function unwrap(x: unknown): FakeReply {
  if (x !== null && typeof x === 'object' && RAW in (x as object)) return (x as { [RAW]: FakeReply })[RAW];
  return { json: x };
}

function resolveReply(v: Scripted, body: any, i = 0): FakeReply {
  return unwrap(typeof v === 'function' ? (v as (b: any, i: number) => unknown)(body, i) : v);
}

const INACTIVE = new Set(['completed', 'error', 'canceled', 'not_started', 'parked', 'starting']);

/** One answer of `status`: fields merged over a running default, `raw(reply)`, or a function of the body. */
export type Frame = Partial<RunStatus> | RawReply | ((body: any) => unknown);

export interface SimRun {
  /** The chat the run lands in; default the send's `thread_id`, or NEW_T for a new chat. */
  threadId?: string;
  /** `status` answers, one per call, the last repeated. */
  frames: Frame[];
  /** `status` answers once a stop of this run was accepted; default one `canceled` frame. */
  afterStop?: Frame[];
  /** `status` answers once an answer to this run was delivered (approve). */
  afterAnswer?: Frame[];
  /** Overrides the reply of `send`. */
  send?: Scripted;
  /** Overrides the reply of `approve` for this run. */
  approve?: Scripted;
  /** Overrides the reply of `stop` for this run. */
  stop?: Scripted;
  /** `thread` with this run's id. Default: its last final_text as one markdown block. */
  thread?: Scripted;
}

export interface SimOptions {
  info?: Scripted;
  threads?: ThreadRow[];
  /** The n-th send starts runs[n]. */
  runs?: SimRun[];
  open?: Scripted;
  /** `thread` without a run id (the whole chat). */
  thread?: Scripted;
  apply?: Scripted;
  /** Replaces a route's handler entirely. */
  routes?: Record<string, FakeHandler>;
}

export interface LiveRun {
  script: SimRun;
  /** The id the send named, and every id a frame answered with. */
  ids: Set<string>;
  current: string;
  threadId: string | null;
  i: number;
  stopI: number;
  answerI: number;
  stopped: boolean;
  answered: boolean;
  last: any;
}

export interface Sim {
  handlers: Record<string, FakeHandler>;
  /** Runs started so far, in order. */
  runs: LiveRun[];
}

export function chatSim(opts: SimOptions = {}): Sim {
  const runs: LiveRun[] = [];
  const find = (id: unknown) => runs.find((r) => typeof id === 'string' && r.ids.has(id));
  const isActive = (r: LiveRun) => !r.stopped && (r.last ? r.last.is_active === true : true);

  const frameFor = (run: LiveRun, body: any): FakeReply => {
    let list: Frame[];
    let idx: number;
    if (run.stopped) {
      list = run.script.afterStop ?? [{ state: 'canceled', is_active: false }];
      idx = run.stopI++;
    } else if (run.answered && run.script.afterAnswer) {
      list = run.script.afterAnswer;
      idx = run.answerI++;
    } else {
      list = run.script.frames;
      idx = run.i++;
    }
    const f = list[Math.min(idx, list.length - 1)];
    const x = typeof f === 'function' ? f(body) : f;
    if (x !== null && typeof x === 'object' && RAW in (x as object)) return unwrap(x);
    const merged: any = {
      ok: true,
      thread_id: run.threadId,
      thread_name: run.threadId ? 'Test chat' : null,
      run_id: run.current,
      state: 'running',
      error: null,
      text: run.last?.text ?? '',
      final_text: run.last?.final_text ?? '',
      tool_calls: [],
      approvals: [],
      questions: [],
      credit_confirmations: [],
      actions: run.last?.actions ?? [],
      ...(x as object),
    };
    if (!('is_active' in (x as object))) merged.is_active = !INACTIVE.has(merged.state);
    if (typeof merged.run_id === 'string') {
      run.ids.add(merged.run_id);
      run.current = merged.run_id;
    }
    if (merged.thread_id) run.threadId = merged.thread_id;
    run.last = merged;
    return { json: merged };
  };

  const handlers: Record<string, FakeHandler> = {
    info: (body, i) =>
      resolveReply(
        opts.info ?? {
          ok: true,
          interface_version: 1,
          plugin_version: '0.27.0-beta.3',
          windows: [{ id: WIN, kind: 'main', status: 'ready' }],
          default_window_id: WIN,
        },
        body,
        i,
      ),
    threads: (body) => {
      const q = typeof body.query === 'string' ? body.query.toLowerCase() : '';
      const rows = (opts.threads ?? []).filter((t) => !q || (t.name ?? '').toLowerCase().includes(q));
      return { json: { ok: true, threads: rows.slice(0, body.limit ?? 20), next_cursor: null, has_more: false } };
    },
    open: (body, i) =>
      resolveReply(opts.open ?? ((b: any) => ({ ok: true, thread_id: b.thread_id === 'new' ? null : b.thread_id, switched: true })), body, i),
    send: (body, i) => {
      const script = opts.runs?.[i];
      if (!script) return { status: 500, json: { ok: false, code: 'internal', message: 'no run scripted' } };
      const run: LiveRun = {
        script,
        ids: new Set([body.run_id]),
        current: body.run_id,
        threadId: script.threadId ?? (body.thread_id === 'new' ? NEW_T : body.thread_id),
        i: 0,
        stopI: 0,
        answerI: 0,
        stopped: false,
        answered: false,
        last: null,
      };
      runs.push(run);
      return resolveReply(
        script.send ??
          ((b: any) => ({ ok: true, thread_id: b.thread_id === 'new' ? null : b.thread_id, run_id: b.run_id, started: true, unresolved_items: [] })),
        body,
      );
    },
    status: (body) => {
      const run = find(body.run_id);
      if (!run) return { status: 404, json: { ok: false, code: 'run_not_found', message: 'The chat shown has no run with this id' } };
      return frameFor(run, body);
    },
    stop: (body) => {
      const run =
        body.run_id !== undefined ? find(body.run_id) : [...runs].reverse().find((r) => r.threadId === body.thread_id && isActive(r));
      if (run?.script.stop !== undefined) return resolveReply(run.script.stop, body);
      if (!run || !isActive(run)) return { json: { ok: true, stopped: false, run_id: null } };
      run.stopped = true;
      return { json: { ok: true, stopped: true, run_id: run.current } };
    },
    approve: (body) => {
      const run = find(body.run_id);
      if (!run) return { status: 404, json: { ok: false, code: 'run_not_found', message: 'This run is not the active run of the chat shown' } };
      const reply = resolveReply(run.script.approve ?? { ok: true, delivered: true }, body);
      if ((reply.json as any)?.delivered === true) run.answered = true;
      return reply;
    },
    apply: (body) => resolveReply(opts.apply ?? ((b: any) => ({ ok: true, applied: [b.action_id], failed: [] })), body),
    thread: (body) => {
      if (body.run_id === undefined) {
        return resolveReply(
          opts.thread ??
            ((b: any) => ({
              ok: true,
              thread_id: b.thread_id,
              title: 'Test chat',
              run_ids: runs.map((r) => r.current),
              blocks: runs.map((r) => ({ type: 'markdown', markdown: r.last?.final_text || r.last?.text || '' })),
              citations: { by_key: {}, page_labels_by_attachment_id: {} },
            })),
          body,
        );
      }
      const run = find(body.run_id);
      if (!run) return { status: 404, json: { ok: false, code: 'run_not_found', message: 'The chat shown has no run with this id' } };
      return resolveReply(
        run.script.thread ??
          ((b: any) => ({
            ok: true,
            thread_id: b.thread_id,
            title: 'Test chat',
            run_ids: [...run.ids],
            blocks: [{ type: 'markdown', markdown: run.last?.final_text || run.last?.text || '' }],
            citations: { by_key: {}, page_labels_by_attachment_id: {} },
          })),
        body,
      );
    },
    ...opts.routes,
  };
  return { handlers, runs };
}
