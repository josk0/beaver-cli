import { BeaverError, ROUTES_OFF_MESSAGE, SIGNED_OUT_MESSAGE, type ErrorCode } from '../core/errors.js';
import { INTERFACE_VERSION, ROUTES, WINDOW_ROUTES, type RouteName } from './routes.js';
import type {
  ApplyResult,
  ApproveBody,
  Info,
  ItemRef,
  OpenResult,
  RunState,
  RunStatus,
  SendResult,
  StopResult,
  ThreadPage,
  ThreadView,
} from './types.js';

export interface ClientOptions {
  port: number;
  /** Sent as `window_id` on every window route. */
  windowId?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number; // default 15000
  /** `thread` builds the whole chat with its citations and may take longer than other routes. */
  threadTimeoutMs?: number; // default 60000
  /** Aborts in-flight requests; an abort caused by it surfaces as BeaverError 'stopped'. */
  signal?: AbortSignal;
}

type Json = Record<string, any>;

/** The most chats `threads` lists at once. */
export const MAX_THREADS = 50;
export const validThreadLimit = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_THREADS;
const RUN_STATES: ReadonlySet<string> = new Set<RunState>([
  'starting', 'not_started', 'running', 'awaiting_input', 'finalizing', 'completed', 'error', 'canceled', 'parked',
]);

/** Error codes of the chat routes -> the command's error codes. Anything else is `protocol`. */
const REFUSALS: Record<string, ErrorCode> = {
  bad_request: 'protocol',
  internal: 'protocol',
  not_authenticated: 'not_authenticated',
  thread_not_found: 'thread_not_found',
  thread_other_instance: 'thread_other_instance',
  run_not_found: 'run_not_found',
  action_not_found: 'action_not_found',
  action_not_pending: 'action_not_pending',
  use_approve: 'use_approve',
  duplicate_run: 'duplicate_run',
  library_excluded: 'library_excluded',
  busy_run: 'busy_run',
  busy_cards: 'busy_cards',
  busy_draft: 'busy_draft',
  busy_attachments: 'busy_attachments',
  thread_busy: 'thread_busy',
  thread_conflict: 'thread_conflict',
  window_changed: 'window_changed',
  account_changed: 'account_changed',
  library_access_changed: 'library_access_changed',
  no_window: 'no_window',
  // Zotero's own answer for a route released while it runs (the setting switched off).
  endpoint_unavailable: 'beaver_unavailable',
};

export class BeaverClient {
  readonly port: number;
  readonly windowId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly threadTimeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: ClientOptions) {
    this.port = opts.port;
    this.windowId = opts.windowId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.threadTimeoutMs = opts.threadTimeoutMs ?? 60000;
    this.signal = opts.signal;
  }

  /** Interface version, plugin version and windows. A version this command cannot read is `beaver_unavailable`. */
  async info(): Promise<Info> {
    const res = await this.post<Info>('info', {});
    if (res.interface_version !== INTERFACE_VERSION) {
      throw new BeaverError(
        'beaver_unavailable',
        `Beaver serves chat interface version ${String(res.interface_version)}; this command reads version ${INTERFACE_VERSION}.`,
        { port: this.port, nextStep: 'Update the beaver command to a version that supports this Beaver build.' },
        res,
      );
    }
    if (!Array.isArray(res.windows)) throw this.err('protocol', 'info returned no windows array', res);
    return res;
  }

  /** `limit` must be 1–50 (Beaver's range); anything else is a usage error, before any request. */
  async threads(args: { query?: string; limit?: number; after?: string } = {}): Promise<ThreadPage> {
    if (args.limit !== undefined && !validThreadLimit(args.limit)) {
      throw this.err('usage', `The number of chats to list must be a whole number from 1 to ${MAX_THREADS}.`);
    }
    const body: Json = {};
    if (args.query !== undefined && args.query.trim() !== '') body.query = args.query;
    if (args.limit !== undefined) body.limit = args.limit;
    if (args.after !== undefined) body.after = args.after;
    const res = await this.post<ThreadPage>('threads', body);
    if (!Array.isArray(res.threads)) throw this.err('protocol', 'threads returned no threads array', res);
    return res;
  }

  /** Shows the chat (or a new chat) in the window; refuses with a busy code instead of disturbing the window. */
  async open(threadId: string | 'new'): Promise<OpenResult> {
    const res = await this.post<OpenResult>('open', { thread_id: threadId });
    if (!(res.thread_id === null || typeof res.thread_id === 'string') || typeof res.switched !== 'boolean') {
      throw this.err('protocol', 'open answered without thread_id and switched', res);
    }
    return res;
  }

  async send(args: { threadId: string | 'new'; text: string; runId: string; items?: ItemRef[] }): Promise<SendResult> {
    const body: Json = { thread_id: args.threadId, text: args.text, run_id: args.runId };
    if (args.items && args.items.length > 0) body.items = args.items;
    const res = await this.post<SendResult>('send', body);
    if (res.run_id !== args.runId) throw this.err('protocol', `send answered for run ${String(res.run_id)}, not ${args.runId}`, res);
    if (typeof res.started !== 'boolean') throw this.err('protocol', 'send answered without started', res);
    return res;
  }

  /** The run, or the newest run that continues it; its `run_id` says which. */
  async status(args: { runId: string; threadId?: string | null }): Promise<RunStatus> {
    const body: Json = { run_id: args.runId };
    if (args.threadId) body.thread_id = args.threadId;
    const res = await this.post<RunStatus>('status', body);
    if (typeof res.run_id !== 'string' || res.run_id === '') throw this.err('protocol', 'status answered without a run_id', res);
    if (!RUN_STATES.has(res.state)) throw this.err('protocol', `status answered an unknown state: ${String(res.state)}`, res);
    if (typeof res.is_active !== 'boolean') throw this.err('protocol', 'status answered without is_active', res);
    return res;
  }

  async approve(args: { runId: string; threadId?: string | null } & ApproveBody): Promise<{ delivered: boolean }> {
    const { runId, threadId, ...answer } = args;
    const body: Json = { run_id: runId, ...answer };
    if (threadId) body.thread_id = threadId;
    return this.post<{ delivered: boolean }>('approve', body);
  }

  apply(args: { threadId: string; actionId: string }): Promise<ApplyResult> {
    return this.post<ApplyResult>('apply', { thread_id: args.threadId, action_id: args.actionId });
  }

  /** With `runId`: only that run (or the newest run continuing it), when it is active. */
  async stop(args: { runId?: string; threadId?: string | null }): Promise<StopResult> {
    const body: Json = {};
    if (args.runId !== undefined) body.run_id = args.runId;
    if (args.threadId) body.thread_id = args.threadId;
    const res = await this.post<StopResult>('stop', body);
    if (res.stopped === true && (typeof res.run_id !== 'string' || res.run_id === '')) {
      throw this.err('protocol', 'stop answered stopped without a run_id', res);
    }
    return res;
  }

  /** The chat as blocks with citations; with `runId`, the final answer of that response. */
  async thread(args: { threadId: string; runId?: string }): Promise<ThreadView> {
    const body: Json = { thread_id: args.threadId };
    if (args.runId !== undefined) body.run_id = args.runId;
    const res = await this.post<ThreadView>('thread', body, {
      timeoutMs: this.threadTimeoutMs,
      timeoutMessage: (secs) => `Beaver did not finish reading the chat within ${secs} s.`,
    });
    if (res.thread_id !== args.threadId) throw this.err('protocol', `thread answered for chat ${String(res.thread_id)}, not ${args.threadId}`, res);
    if (!Array.isArray(res.blocks)) throw this.err('protocol', 'thread answered without blocks', res);
    return res;
  }

  private err(code: ErrorCode, message: string, detail?: unknown): BeaverError {
    return new BeaverError(code, message, { port: this.port }, detail);
  }

  private stopped(): BeaverError {
    return this.err('stopped', 'The request was cancelled before Beaver answered');
  }

  /** POST one route and classify every failure into a BeaverError. */
  private async post<T>(
    route: RouteName,
    body: Json,
    opts: { timeoutMs?: number; timeoutMessage?: (secs: number) => string } = {},
  ): Promise<T> {
    const payload: Json = this.windowId !== undefined && WINDOW_ROUTES.has(route) ? { ...body, window_id: this.windowId } : body;
    const url = `http://127.0.0.1:${this.port}${ROUTES[route]}`;

    if (this.signal?.aborted) throw this.stopped();

    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    this.signal?.addEventListener('abort', onAbort, { once: true });
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      if (this.signal?.aborted) throw this.stopped();
      if (timedOut) {
        // Zotero accepted the connection but did not answer: usually a modal dialog blocks it.
        const secs = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : timeoutMs / 1000;
        const message = opts.timeoutMessage?.(secs) ?? `Zotero did not answer within ${secs} s. A dialog may be open in the Zotero window.`;
        const te = this.err('protocol', message, e);
        te.maybeSent = true;
        throw te;
      }
      // Only a refused connection, or a port fetch will not use at all, proves the request never
      // reached Zotero.
      const refused = errnoOf(e) === 'ECONNREFUSED' || causeMessage(e) === 'bad port';
      const ue = this.err(
        'zotero_unreachable',
        refused
          ? `Zotero is not running on this computer, or it does not listen on port ${this.port} (${describe(e)}).`
          : `The connection to Zotero on port ${this.port} broke (${describe(e)}).`,
        e,
      );
      ue.maybeSent = !refused;
      throw ue;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }

    let json: unknown;
    let parsed = false;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
        parsed = true;
      } catch {
        // handled below, by status
      }
    }
    const obj: Json | null = parsed && json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Json) : null;

    // A refusal of a chat route ({ok:false, code, message}), or one of Zotero's endpoint wrapper ({error_code}).
    const code = obj?.ok === false && typeof obj.code === 'string' ? obj.code : typeof obj?.error_code === 'string' ? obj.error_code : undefined;
    if (code !== undefined) {
      const message = typeof obj?.message === 'string' ? obj.message : typeof obj?.error === 'string' ? obj.error : undefined;
      const mapped = REFUSALS[code] ?? 'protocol';
      const said =
        mapped === 'not_authenticated' ? SIGNED_OUT_MESSAGE : code === 'endpoint_unavailable' ? ROUTES_OFF_MESSAGE : (message ?? `Beaver refused the request (HTTP ${status})`);
      const e = this.err(mapped, mapped === code || code === 'endpoint_unavailable' ? said : `${said} (${code})`, obj);
      e.serverCode = code;
      throw e;
    }

    if (status === 404) {
      throw this.err('beaver_unavailable', ROUTES_OFF_MESSAGE, text);
    }
    if (status < 200 || status >= 300) {
      throw this.err('protocol', `Unexpected HTTP ${status} from ${ROUTES[route]}: ${truncate(text)}`, json ?? text);
    }

    // HTTP 2xx from here on.
    if (text.trim() === '') throw this.err('protocol', `Empty response body from ${ROUTES[route]} (HTTP ${status})`, text);
    if (obj === null) throw this.err('protocol', `Response from ${ROUTES[route]} is not a JSON object: ${truncate(text)}`, text);
    if (obj.ok !== true) throw this.err('protocol', `${ROUTES[route]} answered without ok:true`, obj);
    return obj as T;
  }
}

/**
 * Reads `info` once and returns a client pinned to one window: `windowId` when given (it must be listed),
 * else Beaver's default window.
 */
export async function connect(opts: ClientOptions): Promise<{ client: BeaverClient; info: Info }> {
  const probe = new BeaverClient({ ...opts, windowId: undefined });
  const info = await probe.info();
  const windowId = opts.windowId ?? info.default_window_id;
  if (windowId === null || windowId === undefined) {
    throw new BeaverError('no_window', 'No Zotero window runs Beaver.', { port: opts.port }, info);
  }
  if (opts.windowId !== undefined && !info.windows.some((w) => w.id === opts.windowId)) {
    throw new BeaverError('no_window', `No Zotero window has the id ${opts.windowId}.`, { port: opts.port }, info);
  }
  return { client: new BeaverClient({ ...opts, windowId }), info };
}

function errnoOf(e: unknown): string | undefined {
  return (e as { cause?: { code?: string } } | undefined)?.cause?.code;
}

function causeMessage(e: unknown): string | undefined {
  const m = (e as { cause?: { message?: unknown } } | undefined)?.cause?.message;
  return typeof m === 'string' ? m : undefined;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: { code?: string } }).cause;
    // fetch refuses some reserved ports (e.g. 1) without connecting: cause "bad port", no code.
    return cause?.code ?? causeMessage(e) ?? e.message;
  }
  return String(e);
}

function truncate(s: string, n = 200): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}
