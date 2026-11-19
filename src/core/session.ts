import { randomUUID } from 'node:crypto';
import type { BeaverClient } from '../client/http.js';
import type { ApplyResult, ApproveBody, RunAction, RunState, RunStatus, SendResult, ThreadPage } from '../client/types.js';
import { BeaverError, nextStepFor, type ErrorCode } from './errors.js';
import { PAUSE_ANSWERED_ELSEWHERE, type PauseDecision, type PausePolicy } from './policy.js';
import { readAnswer, readTranscript, renderKnownNames, stripCitationTags, type Source } from './result.js';
import { FINAL, pauseKey, pausesOf, type Pause } from './settle.js';

export { stripCitationTags } from './result.js';

export interface AskOptions {
  /** `latest`: the most recently updated saved chat. */
  thread: { new: true } | { id: string } | { latest: true };
  text: string;
  items?: Array<{ library_ref: string; zotero_key: string }>;
  timeoutMs: number;
  pollMs?: number; // default 700
  policy: PausePolicy;
  onProgress?: (
    e:
      | { kind: 'tool'; name: string; label: string | null }
      /** The run's full raw text so far (citation tags included), whenever it changed. */
      | { kind: 'text'; text: string }
      | { kind: 'pause'; pause: Pause; decision: PauseDecision },
  ) => void;
  /**
   * Aborts the ask: the command tries to stop its run and returns the partial answer. Do not give the
   * same signal to the BeaverClient: an aborted client cannot send the stop.
   */
  signal?: AbortSignal;
  /** The run id the send names; a fresh UUID when unset. */
  runId?: string;
  /**
   * Display names already known, by citation tag id: used when the answer has to be taken from the
   * run's own text instead of Beaver's rendering of it.
   */
  nameOf?: (tagId: string) => string | null;
}

export interface ActionRecord {
  id: string;
  type: string;
  status: string;
}

export interface AskResult {
  status: 'ok' | 'error';
  thread_id: string | null;
  thread_name: string | null;
  /** The run that answered: the one the send named, or the newest run that continues it. */
  run_id: string | null;
  /** The run id the send named. */
  sent_run_id: string | null;
  answer: string;
  references: string;
  sources: Source[];
  applied_actions: ActionRecord[];
  declined_actions: Array<ActionRecord & { apply_command: string | null }>;
  unresolved_items: Array<{ library_ref?: string; item_key: string; status: string }>;
  warnings: string[];
  error: { code: ErrorCode; message: string; next_step: string } | null;
}

export const STOP_UNCONFIRMED = 'Could not confirm that the run was stopped; check the Zotero window.';
export const DECLINED_WARNING = 'A declined change can be applied later with its apply_command.';
export const MAYBE_SENT_WARNING = 'The message may have been sent; check the Zotero window.';
export const LATE_START_WARNING =
  'The message may still start in Zotero after this command has exited; check the Zotero window and stop the run there if it starts.';
export const ANSWER_FROM_TEXT_WARNING = "The answer was read from the run's text; sources may be incomplete.";

/** How long an answered pause may stay pending before the answer counts as not delivered. */
const ANSWER_GRACE_MS = 10_000;
/** How long, after a stop, the command waits to see the run end. */
const STOP_CONFIRM_MS = 5_000;
const STOP_POLL_MS = 250;
/** The consecutive failed poll reads that end the ask. */
const MAX_POLL_FAILURES = 3;
/** A send whose run is still `starting` after this long is given up (stopped, `send_unknown`). */
const START_MS = 30_000;
/** A failed run that Beaver may resume or retry is watched this long before it counts as failed. */
const ERROR_GRACE_MS = 3_000;
/** A run waiting on input that `status` does not list (e.g. a batch approval) is given up after this long. */
const UNLISTED_MS = 15_000;
/** A run that `status` reports as running but not active, this many polls and this long, is given up. */
const STALE_POLLS = 5;
const STALE_MS = 3_000;
/** A completed run of a new chat waits this long for the chat's id before the ask gives up. */
const THREAD_ID_MS = 5_000;
/** The final read of a completed run's answer gets at least this long, also when --timeout is nearly up. */
const ANSWER_FLOOR_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The error for a chat id that is not one: `thread_not_found`, raised before any request. */
export const notAChatId = (value: string, port: number): BeaverError =>
  new BeaverError('thread_not_found', `'${value}' is not a chat id.`, { port });
/** Whether `value` has the form of a chat id (a UUID). */
export const isChatId = (value: string): boolean => UUID.test(value.trim());
/** Refusals Beaver makes before it sends anything: nothing was sent. */
const PRE_SEND = new Set([
  'bad_request', 'not_authenticated', 'no_window', 'duplicate_run', 'busy_run', 'busy_cards', 'busy_draft',
  'busy_attachments', 'thread_busy', 'thread_conflict', 'thread_not_found', 'thread_other_instance', 'window_changed',
]);

/** Result of a stop: stopped and seen to end, nothing active to stop, or sent but not seen to end. */
export type StopOutcome = 'confirmed' | 'not_running' | 'unconfirmed';

/** The interactive `/stop`: the outcome, and for a confirmed stop the state the run ended in, if read. */
export interface StopReport {
  outcome: StopOutcome;
  status: RunState | null;
}

const ABORT = Symbol('abort');
class Aborted extends Error {}

function pauseWord(kind: Pause['kind']): string {
  return kind === 'credits' ? 'credit confirmation' : kind;
}

const UNSUPPORTED_LABEL: Record<Extract<Pause, { kind: 'unsupported' }>['what'], string> = {
  parked: 'cards that were put aside in the Zotero window',
  unlisted: 'an answer that only the Zotero window can show (for example a batch approval or a table)',
};

function fits(pause: Pause, d: PauseDecision): boolean {
  if (d.action === 'stop') return true;
  switch (pause.kind) {
    case 'approval':
      return d.action === 'approve' || d.action === 'decline';
    case 'question':
      return d.action === 'cancel_question' || d.action === 'answer_question';
    case 'credits':
      return d.action === 'confirm_credits' || d.action === 'decline_credits';
    case 'unsupported':
      return false;
  }
}

/** Whether the run, as `s` shows it, still waits on `pause`. */
function stillPending(s: RunStatus, pause: Pause): boolean {
  if (pause.kind === 'unsupported') {
    return pause.what === 'parked' ? s.state === 'parked' : s.state === 'awaiting_input' && pausesOf(s).length === 0;
  }
  return pausesOf(s).some((p) => pauseKey(p) === pauseKey(pause));
}

/** A failed read that may pass while a run is polled. */
function transient(e: unknown): e is BeaverError {
  return (
    e instanceof BeaverError &&
    (e.code === 'protocol' || e.code === 'no_window' || e.code === 'zotero_unreachable' || e.code === 'beaver_unavailable')
  );
}

/**
 * A send that certainly did not reach Beaver's chat: a refusal Beaver makes before sending, or a
 * connection that was refused. Anything else (a timeout, a reset connection, an unreadable answer,
 * `internal`, routes that went away during the request) may have sent the message.
 */
function certainlyNotSent(e: BeaverError): boolean {
  if (e.code === 'zotero_unreachable') return e.maybeSent !== true;
  return e.serverCode !== undefined && PRE_SEND.has(e.serverCode);
}

/** Everything the ask knows about the run it started. */
interface RunCtx {
  opts: AskOptions;
  pollMs: number;
  deadline: number;
  sentRunId: string;
  /** The run to ask about: the sent one, or the newest run Beaver said continues it. */
  runId: string;
  threadId: string | null;
  threadName: string | null;
  lastText: string;
  last: RunStatus | null;
  actions: RunAction[];
  seenTools: Set<string>;
  answered: Map<string, { at: number; kind: Pause['kind'] }>;
  declined: Map<string, string>; // actionId -> actionType
  unresolved: AskResult['unresolved_items'];
  warnings: string[];
  aborted: Promise<typeof ABORT>;
  failedPolls: number;
  /** Whether a status other than `starting` was seen: then the send certainly started the run. */
  seen: boolean;
  sentAt: number;
  errorSince: number | null;
  unlistedSince: number | null;
  staleSince: number | null;
  stalePolls: number;
  completedSince: number | null;
  /** Whether a route confirmed `threadId` (the send, or a status answer naming it). */
  threadConfirmed: boolean;
  /** Keys of the pauses the run listed last; when they are gone, the unlisted clock waits longer. */
  listed: Set<string>;
  /** How long nothing may be listed before the run counts as waiting on unlisted input. */
  unlistedLimit: number;
}

export class ChatSession {
  /** The chat this session is bound to (set once a send or an open identified it). */
  threadId: string | null = null;
  /** The run of the latest ask, once sent (it follows a resume); kept after the ask for late name lookups. */
  runId: string | null = null;

  private readonly client: BeaverClient;
  private readonly port: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly answerFloorMs: number;

  constructor(
    client: BeaverClient,
    opts: { port: number; sleep?: (ms: number) => Promise<void>; now?: () => number; answerFloorMs?: number },
  ) {
    this.client = client;
    this.port = opts.port;
    this.answerFloorMs = opts.answerFloorMs ?? ANSWER_FLOOR_MS;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  private err(code: ErrorCode, message: string, detail?: unknown): BeaverError {
    return new BeaverError(code, message, { port: this.port }, detail);
  }

  /** A chat id as given by a person or program: a UUID, else `thread_not_found` before any request. */
  private chatId(value: string): string {
    if (!isChatId(value)) throw notAChatId(value, this.port);
    return value.trim();
  }

  /** Saved chats, most recently updated first; with a query, the matches. */
  async threads(query?: string, limit = 20, after?: string): Promise<ThreadPage> {
    const page = await this.client.threads({ query, limit, after });
    if (query === undefined || query.trim() === '') page.threads.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return page;
  }

  /** The most recently updated saved chat; `thread_not_found` when there is none. */
  async latestThreadId(): Promise<string> {
    const { threads } = await this.threads(undefined, 10);
    if (threads.length === 0) throw this.err('thread_not_found', 'There is no saved chat to continue.');
    return threads[0].id;
  }

  /**
   * Shows the chat in the window and binds the session to it. Beaver refuses (busy codes) instead of
   * disturbing the window.
   */
  async open(thread: { id: string } | { latest: true }): Promise<string> {
    const id = 'id' in thread ? this.chatId(thread.id) : await this.latestThreadId();
    await this.client.open(id);
    this.threadId = id;
    return id;
  }

  /** Applies a change of a saved chat that was declined or left undecided. */
  async apply(threadId: string, actionId: string): Promise<ApplyResult> {
    this.chatId(threadId);
    await this.client.open(threadId);
    return this.client.apply({ threadId, actionId });
  }

  /**
   * Never throws for run-level outcomes. Throws BeaverError only when nothing was sent: before the
   * send, or when Beaver refused it.
   */
  async ask(opts: AskOptions): Promise<AskResult> {
    const deadline = this.now() + opts.timeoutMs;
    if (opts.signal?.aborted) throw this.err('stopped', 'Cancelled before the message was sent.');
    const target = 'new' in opts.thread ? 'new' : 'id' in opts.thread ? this.chatId(opts.thread.id) : await this.latestThreadId();
    if (opts.signal?.aborted) throw this.err('stopped', 'Cancelled before the message was sent.');

    const runId = opts.runId ?? randomUUID();
    this.runId = null;
    const ctx: RunCtx = {
      opts,
      pollMs: opts.pollMs ?? 700,
      deadline,
      sentRunId: runId,
      runId,
      threadId: target === 'new' ? null : target,
      threadName: null,
      lastText: '',
      last: null,
      actions: [],
      seenTools: new Set(),
      answered: new Map(),
      declined: new Map(),
      unresolved: [],
      warnings: [],
      aborted: abortPromise(opts.signal),
      failedPolls: 0,
      seen: false,
      sentAt: 0,
      errorSince: null,
      unlistedSince: null,
      staleSince: null,
      stalePolls: 0,
      completedSince: null,
      threadConfirmed: false,
      listed: new Set(),
      unlistedLimit: UNLISTED_MS,
    };

    let sent: SendResult | null = null;
    try {
      sent = await this.client.send({ threadId: target, text: opts.text, runId, items: opts.items });
    } catch (e) {
      if (!(e instanceof BeaverError)) throw e;
      if (e.code === 'account_changed' || e.code === 'library_access_changed') {
        ctx.warnings.push(MAYBE_SENT_WARNING);
        return this.fail(ctx, e.code, e.message);
      }
      if (certainlyNotSent(e)) throw e;
      // The run id is ours, so `status` tells whether the message arrived; it is never sent again.
      ctx.warnings.push(MAYBE_SENT_WARNING);
    }
    ctx.sentAt = this.now();
    this.runId = runId;
    if (sent) {
      ctx.unresolved = (sent.unresolved_items ?? []).map((u) => ({
        ...(u.library_ref !== undefined ? { library_ref: u.library_ref } : {}),
        item_key: u.zotero_key,
        status: u.status,
      }));
      if (ctx.unresolved.length > 0) {
        const keys = ctx.unresolved.map((u) => `${u.item_key} (${u.status})`).join(', ');
        ctx.warnings.push(`Some items could not be attached and were not sent: ${keys}.`);
      }
      // Beaver opened the chat to send: its id is confirmed.
      if (sent.thread_id) ctx.threadId = sent.thread_id;
      ctx.threadConfirmed = ctx.threadId !== null;
      if (sent.started) ctx.seen = true;
    }
    if (ctx.threadConfirmed) this.threadId = ctx.threadId;
    return this.poll(ctx);
  }

  /**
   * Interactive `/stop`: stops whatever run is active in the bound chat, also one started in the
   * window; never a run in another chat.
   */
  async stop(): Promise<StopReport> {
    const threadId = this.threadId;
    if (threadId === null) return { outcome: 'not_running', status: null };
    const res = await this.client.stop({ threadId });
    if (!res.stopped || res.run_id === null) return { outcome: 'not_running', status: null };
    const until = this.now() + STOP_CONFIRM_MS;
    for (;;) {
      try {
        const s = await this.client.status({ runId: res.run_id, threadId });
        if (!s.is_active || FINAL.has(s.state)) return { outcome: 'confirmed', status: s.state };
      } catch {
        return { outcome: 'unconfirmed', status: null };
      }
      if (this.now() >= until) return { outcome: 'unconfirmed', status: null };
      await this.sleepFn(STOP_POLL_MS);
    }
  }

  /**
   * The whole bound chat. Shows it in the window first, since Beaver reads only the chat shown; `opened`
   * skips that when the caller just opened it.
   */
  async transcript(opts: { opened?: boolean } = {}): Promise<{ title: string; body: string; references: string }> {
    const id = this.threadId;
    if (id === null) throw this.err('usage', 'No chat is open in this session yet.');
    if (!opts.opened) await this.client.open(id);
    const t = readTranscript(await this.client.thread({ threadId: id }));
    return { title: t.title, body: t.body, references: t.references };
  }

  // ---------------------------------------------------------------------------------------------

  private async poll(ctx: RunCtx): Promise<AskResult> {
    for (;;) {
      try {
        if (ctx.opts.signal?.aborted) return await this.endInterrupted(ctx, 'stopped');
        if (this.now() >= ctx.deadline) return await this.endInterrupted(ctx, 'timeout');
        await this.read(ctx, this.sleepFn(Math.max(0, Math.min(ctx.pollMs, ctx.deadline - this.now()))));
        if (ctx.opts.signal?.aborted) return await this.endInterrupted(ctx, 'stopped');

        const s = await this.read(ctx, this.status(ctx));
        ctx.failedPolls = 0;
        const end = await this.step(ctx, s);
        if (end) return end;
      } catch (e) {
        if (e instanceof Aborted) return await this.endInterrupted(ctx, 'stopped');
        if (transient(e) && ++ctx.failedPolls < MAX_POLL_FAILURES) continue;
        return await this.endPollError(ctx, e);
      }
    }
  }

  private status(ctx: RunCtx): Promise<RunStatus> {
    return this.client.status({ runId: ctx.runId, threadId: ctx.threadId });
  }

  /** Takes in what one `status` answer says: the run's id, the chat's id, text, tool calls and changes. */
  private observe(ctx: RunCtx, s: RunStatus): void {
    if (s.run_id !== ctx.runId) {
      ctx.runId = s.run_id;
      this.runId = s.run_id;
    }
    if (s.thread_id && (ctx.threadId === null || s.thread_id === ctx.threadId)) {
      ctx.threadId = s.thread_id;
      ctx.threadConfirmed = true;
      this.threadId = s.thread_id;
    }
    if (s.thread_name) ctx.threadName = s.thread_name;
    if (s.state !== 'starting' && !ctx.seen) {
      ctx.seen = true;
      // The run exists: the message arrived, whatever the send's answer said.
      const i = ctx.warnings.indexOf(MAYBE_SENT_WARNING);
      if (i >= 0) ctx.warnings.splice(i, 1);
    }
    ctx.last = s;
    if (Array.isArray(s.actions)) ctx.actions = s.actions;
    if (typeof s.text === 'string' && s.text !== ctx.lastText && (s.text !== '' || ctx.lastText === '')) {
      ctx.lastText = s.text;
      ctx.opts.onProgress?.({ kind: 'text', text: s.text });
    }
    for (const tc of s.tool_calls ?? []) {
      if (ctx.seenTools.has(tc.id)) continue;
      ctx.seenTools.add(tc.id);
      ctx.opts.onProgress?.({ kind: 'tool', name: tc.name, label: tc.label ?? null });
    }
  }

  /** One poll. Returns a result when the ask is over, else undefined. */
  private async step(ctx: RunCtx, s: RunStatus): Promise<AskResult | undefined> {
    this.observe(ctx, s);
    const now = this.now();
    if (s.state !== 'error') ctx.errorSince = null;
    if (s.state !== 'awaiting_input' || pausesOf(s).length > 0) ctx.unlistedSince = null;
    if (s.state !== 'completed') ctx.completedSince = null;
    if (s.state !== 'awaiting_input') ctx.listed.clear();

    // A run reported as going on that is not the active run: nobody drives it any more.
    if ((s.state === 'running' || s.state === 'awaiting_input') && !s.is_active) {
      if (ctx.stalePolls++ === 0) ctx.staleSince = now;
      if (ctx.stalePolls >= STALE_POLLS && now - (ctx.staleSince ?? now) >= STALE_MS) {
        return this.fail(ctx, 'run_error', `The run stopped in the Zotero window without finishing (state ${s.state}).`);
      }
      return undefined;
    }
    ctx.stalePolls = 0;

    switch (s.state) {
      case 'starting':
        if (now - ctx.sentAt >= START_MS) return this.endSendUnknown(ctx, `Beaver did not start the run within ${START_MS / 1000} s.`);
        return undefined;
      case 'not_started':
        return this.fail(ctx, 'send_failed', 'Beaver did not start the run; the message was not sent.');
      case 'running':
      case 'finalizing':
        return undefined;
      case 'awaiting_input': {
        const pauses = pausesOf(s);
        if (pauses.length > 0) {
          ctx.listed = new Set(pauses.map(pauseKey));
          return this.handlePause(ctx, pauses);
        }
        if (ctx.unlistedSince === null) {
          // The listed pauses were just answered (here or in the window): Beaver gets the answer grace
          // to move on before the wait counts as one on input that is not listed.
          ctx.unlistedSince = now;
          ctx.unlistedLimit = UNLISTED_MS + (ctx.listed.size > 0 ? ANSWER_GRACE_MS : 0);
          ctx.listed.clear();
        }
        if (now - ctx.unlistedSince >= ctx.unlistedLimit) return this.handlePause(ctx, [{ kind: 'unsupported', what: 'unlisted' }]);
        return undefined;
      }
      case 'parked':
        return this.handlePause(ctx, [{ kind: 'unsupported', what: 'parked' }]);
      case 'completed':
        if (ctx.threadId === null) {
          if (ctx.completedSince === null) ctx.completedSince = now;
          if (now - ctx.completedSince >= THREAD_ID_MS) return this.fail(ctx, 'protocol', 'Beaver finished the run but did not name its chat.');
          return undefined;
        }
        return this.succeed(ctx);
      case 'error': {
        // Beaver may resume or retry a failed run by itself; give it a moment before calling it failed.
        const recoverable = s.error?.is_resumable === true || s.error?.is_retryable === true;
        if (ctx.errorSince === null) ctx.errorSince = now;
        if (recoverable && now - ctx.errorSince < ERROR_GRACE_MS) return undefined;
        return this.fail(ctx, 'run_error', `The run was stopped or failed (status error${s.error?.type ? `, ${s.error.type}` : ''}).`);
      }
      case 'canceled':
        return this.fail(ctx, 'run_error', 'The run was stopped or failed (status canceled).');
    }
  }

  private async handlePause(ctx: RunCtx, pauses: Pause[]): Promise<AskResult | undefined> {
    for (const p of pauses) {
      const a = ctx.answered.get(pauseKey(p));
      if (a && this.now() - a.at > ANSWER_GRACE_MS) {
        await this.stopOrWarn(ctx);
        return this.fail(ctx, 'unsupported_pause', `Beaver did not accept the answer to a pending ${pauseWord(a.kind)}.`);
      }
    }
    const pause = pauses.find((p) => !ctx.answered.has(pauseKey(p)));
    if (!pause) return undefined;

    const got = await this.decide(ctx, pause);
    if (got === 'gone') return undefined;
    if (got === 'aborted') return this.endInterrupted(ctx, 'stopped');
    if (got === 'timeout') return this.endInterrupted(ctx, 'timeout');
    const decision: PauseDecision = fits(pause, got) ? got : { action: 'stop' };
    ctx.opts.onProgress?.({ kind: 'pause', pause, decision });

    if (decision.action === 'stop') {
      const stopped = (await this.stopOrWarn(ctx)) === 'confirmed';
      const message =
        pause.kind === 'unsupported'
          ? `The run waits on ${UNSUPPORTED_LABEL[pause.what]}, which this command cannot answer.`
          : `The run ${stopped ? 'was stopped' : 'paused'} at a pending ${pauseWord(pause.kind)}.`;
      return this.fail(ctx, 'unsupported_pause', message);
    }

    // Counted as answered before the request: a request that fails may still have reached Beaver, and
    // the grace rule, not a second answer, decides what happens next.
    ctx.answered.set(pauseKey(pause), { at: this.now(), kind: pause.kind });
    const delivered = await this.answer(ctx, pause, decision);
    if (delivered === 'declined_instead' && pause.kind === 'approval') {
      ctx.declined.set(pause.actionId, pause.actionType);
      ctx.warnings.push(`Beaver did not apply the change ${pause.actionId}: it touches a library excluded from Beaver, so it was declined.`);
      return undefined;
    }
    if (delivered === 'unsupported') {
      await this.stopOrWarn(ctx);
      return this.fail(ctx, 'unsupported_pause', `This Beaver build takes the answer to a ${pauseWord(pause.kind)} only in the Zotero window.`);
    }
    if (pause.kind === 'approval' && decision.action === 'decline' && delivered) ctx.declined.set(pause.actionId, pause.actionType);
    // A decline Beaver did not take (answered in the window meanwhile) is no reason to stop: keep polling.
    if (pause.kind === 'credits' && decision.action === 'decline_credits' && delivered) {
      await this.stopOrWarn(ctx);
      return this.fail(ctx, 'run_error', `The run needs a credit confirmation (${pause.pendingCredits} credits): ${pause.message}`);
    }
    return undefined;
  }

  /**
   * Sends the decision. False when Beaver did not take it (the pause was answered in the window
   * meanwhile, or the run moved on): the answer grace rule covers that. 'unsupported' when this Beaver
   * build refuses the kind of answer; 'declined_instead' when an approval Beaver refused to apply
   * (excluded library) was declined in its place.
   */
  private async answer(ctx: RunCtx, pause: Pause, d: PauseDecision): Promise<boolean | 'unsupported' | 'declined_instead'> {
    let body: ApproveBody;
    if (pause.kind === 'approval') {
      body = { kind: 'approval', action_id: pause.actionId, approved: d.action === 'approve' };
      if (d.action === 'decline' && d.instructions !== undefined) body.instructions = d.instructions;
    } else if (pause.kind === 'question') {
      body =
        d.action === 'answer_question'
          ? { kind: 'question', toolcall_id: pause.toolcallId, answers: d.answers }
          : { kind: 'question', toolcall_id: pause.toolcallId, cancelled: true };
    } else if (pause.kind === 'credits') {
      body = { kind: 'credits', confirmation_id: pause.confirmationId, approved: d.action === 'confirm_credits' };
    } else {
      return false;
    }
    try {
      const res = await this.read(ctx, this.client.approve({ runId: ctx.runId, threadId: ctx.threadId, ...body }));
      return res.delivered === true;
    } catch (e) {
      if (!(e instanceof BeaverError)) throw e;
      if (e.serverCode === 'bad_request' && pause.kind !== 'approval') return 'unsupported';
      if (e.code === 'library_excluded' && body.kind === 'approval' && body.approved) {
        const res = await this.read(ctx, this.client.approve({ runId: ctx.runId, threadId: ctx.threadId, kind: 'approval', action_id: body.action_id, approved: false }));
        return res.delivered === true ? 'declined_instead' : false;
      }
      if (e.code === 'action_not_pending' || e.code === 'run_not_found' || transient(e)) return false;
      throw e;
    }
  }

  /**
   * Asks the policy, raced against the deadline and the abort signal, and re-reads the run every poll
   * interval meanwhile. When the pause is gone (answered in the window), the policy's signal is aborted
   * with PAUSE_ANSWERED_ELSEWHERE and polling resumes. The policy's signal is aborted whenever this
   * returns; a late decision is discarded. A definitive error of a read ends the ask.
   */
  private async decide(ctx: RunCtx, pause: Pause): Promise<PauseDecision | 'timeout' | 'aborted' | 'gone'> {
    const ac = new AbortController();
    const pending = ctx.opts.policy(pause, ac.signal);
    pending.catch(() => {});
    const TICK = Symbol('tick');
    try {
      for (;;) {
        if (ctx.opts.signal?.aborted) return 'aborted';
        const remaining = ctx.deadline - this.now();
        if (remaining <= 0) return 'timeout';
        const r = await Promise.race([pending, ctx.aborted, this.sleepFn(Math.min(ctx.pollMs, remaining)).then(() => TICK)]);
        if (r === ABORT || ctx.opts.signal?.aborted) return 'aborted';
        if (r !== TICK) return this.now() >= ctx.deadline ? 'timeout' : (r as PauseDecision);
        let s: RunStatus;
        try {
          s = await this.read(ctx, this.status(ctx));
        } catch (e) {
          // The person is still deciding: a failed read is no reason to drop the question.
          if (transient(e)) continue;
          throw e;
        }
        this.observe(ctx, s);
        if (!stillPending(s, pause)) {
          ac.abort(PAUSE_ANSWERED_ELSEWHERE);
          return 'gone';
        }
      }
    } finally {
      ac.abort();
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** The ask's stop: only its own run (or the newest run continuing it), and only while it is active. */
  private async stopOurRun(ctx: RunCtx): Promise<StopOutcome> {
    let runId: string;
    try {
      const res = await this.client.stop({ runId: ctx.runId, threadId: ctx.threadId });
      if (!res.stopped || res.run_id === null) return 'not_running';
      runId = res.run_id;
    } catch {
      return 'unconfirmed';
    }
    ctx.runId = runId;
    const until = this.now() + STOP_CONFIRM_MS;
    for (;;) {
      try {
        const s = await this.status(ctx);
        this.observe(ctx, s);
        if (!s.is_active || FINAL.has(s.state)) return 'confirmed';
      } catch {
        return 'unconfirmed';
      }
      if (this.now() >= until) return 'unconfirmed';
      await this.sleepFn(STOP_POLL_MS);
    }
  }

  /** Stops our run; warns when the stop was not seen to take effect. */
  private async stopOrWarn(ctx: RunCtx): Promise<StopOutcome> {
    const outcome = await this.stopOurRun(ctx);
    if (outcome === 'unconfirmed' && !ctx.warnings.includes(STOP_UNCONFIRMED)) ctx.warnings.push(STOP_UNCONFIRMED);
    return outcome;
  }

  private async endInterrupted(ctx: RunCtx, code: 'timeout' | 'stopped'): Promise<AskResult> {
    const outcome = await this.stopOrWarn(ctx);
    // Our run may have completed before the stop took effect: that is an answer, not a timeout or a cancel.
    try {
      const s = await this.status(ctx);
      this.observe(ctx, s);
      if (s.state === 'completed' && ctx.threadId !== null) {
        const i = ctx.warnings.indexOf(STOP_UNCONFIRMED);
        if (i >= 0) ctx.warnings.splice(i, 1);
        return this.succeed(ctx);
      }
    } catch {
      // keep the last partial text
    }
    const stopped = outcome === 'confirmed' ? ' The run was stopped.' : '';
    const message = code === 'timeout' ? `No answer within ${Math.round(ctx.opts.timeoutMs / 1000)} s.${stopped}` : `Cancelled.${stopped}`;
    this.warnNotSeen(ctx);
    return this.fail(ctx, code, message);
  }

  /**
   * The ask gives up on a send whose run it never saw. A stop cannot cancel a send that is still under
   * way, so the result says that the message may still start.
   */
  private warnNotSeen(ctx: RunCtx): void {
    if (ctx.seen) return;
    for (const w of [MAYBE_SENT_WARNING, LATE_START_WARNING]) if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
  }

  /** The send's run never showed up: stop it once in case it starts later, and never send again. */
  private async endSendUnknown(ctx: RunCtx, why: string): Promise<AskResult> {
    await this.stopOurRun(ctx);
    this.warnNotSeen(ctx);
    return this.fail(
      ctx,
      'send_unknown',
      `${why} The message may not have been sent, or may still start in Zotero after this command has exited; check the Zotero window before sending it again.`,
    );
  }

  private async endPollError(ctx: RunCtx, e: unknown): Promise<AskResult> {
    const be =
      e instanceof BeaverError ? e : this.err('protocol', `Unexpected failure while waiting for the run: ${e instanceof Error ? e.message : String(e)}`);
    switch (be.code) {
      case 'run_not_found':
        if (!ctx.seen) return this.endSendUnknown(ctx, 'Beaver does not know the run the message should have started.');
        if (ctx.last?.state === 'error') {
          return this.fail(ctx, 'run_error', 'The run failed, and Beaver replaced it with a new run, which this command cannot follow; check the Zotero window.');
        }
        return this.fail(
          ctx,
          'run_not_found',
          ctx.threadId === null
            ? 'Beaver no longer lists the run; the Zotero window may have switched to another chat before the new chat got its id. Check the Zotero window.'
            : 'Beaver no longer lists the run in this chat; check the Zotero window.',
        );
      case 'window_changed':
        if (!ctx.seen) return this.endSendUnknown(ctx, 'The Zotero window shows another chat, and the run of the message was never seen.');
        return this.fail(
          ctx,
          'window_changed',
          `The Zotero window shows another chat; the run continues there${ctx.threadId ? `: continue with -r ${ctx.threadId}` : ''}.`,
        );
      case 'account_changed':
      case 'library_access_changed':
      case 'not_authenticated':
        this.warnNotSeen(ctx);
        return this.fail(ctx, be.code, be.message);
      case 'zotero_unreachable':
        ctx.warnings.push(STOP_UNCONFIRMED);
        this.warnNotSeen(ctx);
        return this.fail(ctx, be.code, be.message);
      default:
        await this.stopOrWarn(ctx);
        this.warnNotSeen(ctx);
        return this.fail(ctx, be.code, be.message);
    }
  }

  /**
   * Reads the completed run's answer with its citations. The read is bounded by what is left of
   * --timeout (at least ANSWER_FLOOR_MS) and by the abort signal; when it runs out, or Beaver sends no
   * answer block, the answer is taken from the run's own text.
   */
  private async succeed(ctx: RunCtx): Promise<AskResult> {
    const result = this.base(ctx);
    const OUT = Symbol('out');
    let timer: NodeJS.Timeout | undefined;
    const out = new Promise<typeof OUT>((resolve) => {
      timer = setTimeout(() => resolve(OUT), Math.max(this.answerFloorMs, ctx.deadline - this.now()));
      timer.unref?.();
    });
    const reading = this.client.thread({ threadId: ctx.threadId!, runId: ctx.runId });
    reading.catch(() => {});
    try {
      const got = await Promise.race([reading, out, ctx.aborted]);
      if (got === OUT || got === ABORT) return this.answerFromText(ctx, result);
      const r = readAnswer(got);
      if (r.answer === '') return this.answerFromText(ctx, result);
      result.answer = r.answer;
      result.references = r.references;
      result.sources = r.sources;
    } catch (e) {
      const be = e instanceof BeaverError ? e : this.err('protocol', e instanceof Error ? e.message : String(e));
      result.answer = renderKnownNames(ctx.last?.final_text || ctx.lastText, ctx.opts.nameOf);
      return this.withError(result, be.code, be.message);
    }
    finally {
      clearTimeout(timer);
    }
    return result;
  }

  /** The completed run's final text, with the names already known; an empty one is an error. */
  private answerFromText(ctx: RunCtx, result: AskResult): AskResult {
    result.answer = renderKnownNames(ctx.last?.final_text ?? '', ctx.opts.nameOf);
    if (result.answer === '') return this.withError(result, 'protocol', 'Beaver reported the run as completed but sent no answer.');
    result.warnings.push(ANSWER_FROM_TEXT_WARNING);
    return result;
  }

  private base(ctx: RunCtx): AskResult {
    // Only a chat id a route confirmed is reported, never the caller's unverified input.
    const thread = ctx.threadConfirmed ? ctx.threadId : null;
    const applied = ctx.actions.filter((a) => a.status === 'applied');
    const declined: AskResult['declined_actions'] = [];
    for (const [id, type] of ctx.declined) {
      const row = ctx.actions.find((a) => a.id === id);
      if (row?.status === 'applied') continue;
      declined.push({
        id,
        type: row?.action_type ?? type,
        status: row?.status ?? 'unknown',
        apply_command: thread ? `beaver apply ${id} -r ${thread}` : null,
      });
    }
    const warnings = [...ctx.warnings];
    if (declined.length > 0) warnings.push(DECLINED_WARNING);
    return {
      status: 'ok',
      thread_id: thread,
      thread_name: thread !== null ? ctx.threadName : null,
      run_id: ctx.runId,
      sent_run_id: ctx.sentRunId,
      answer: '',
      references: '',
      sources: [],
      applied_actions: applied.map((a) => ({ id: a.id, type: a.action_type, status: a.status })),
      declined_actions: declined,
      unresolved_items: ctx.unresolved,
      warnings,
      error: null,
    };
  }

  private fail(ctx: RunCtx, code: ErrorCode, message: string): AskResult {
    const r = this.base(ctx);
    r.answer = stripCitationTags(ctx.lastText);
    return this.withError(r, code, message);
  }

  private withError(r: AskResult, code: ErrorCode, message: string): AskResult {
    r.status = 'error';
    r.error = { code, message, next_step: nextStepFor(code, { port: this.port }) };
    return r;
  }

  /** Awaits a read, but gives up on it when the ask is aborted. */
  private async read<T>(ctx: RunCtx, p: Promise<T>): Promise<T> {
    p.catch(() => {});
    const r = await Promise.race([p, ctx.aborted]);
    if (r === ABORT) throw new Aborted();
    return r as T;
  }
}

function abortPromise(signal: AbortSignal | undefined): Promise<typeof ABORT> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve(ABORT);
    else signal.addEventListener('abort', () => resolve(ABORT), { once: true });
  });
}
