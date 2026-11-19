import { afterEach, describe, expect, it } from 'vitest';
import { BeaverClient, type ClientOptions } from '../../src/client/http.js';
import { BeaverError } from '../../src/core/errors.js';
import { DECLINE_INSTRUCTION, PAUSE_ANSWERED_ELSEWHERE, scriptPolicy, type PausePolicy } from '../../src/core/policy.js';
import {
  ChatSession,
  ANSWER_FROM_TEXT_WARNING,
  DECLINED_WARNING,
  LATE_START_WARNING,
  MAYBE_SENT_WARNING,
  STOP_UNCONFIRMED,
  stripCitationTags,
  type AskOptions,
  type AskResult,
} from '../../src/core/session.js';
import { chatSim, fixture, NEW_T, raw, refusal, startFakeBeaver, type FakeBeaver, type Frame, type SimOptions } from '../helpers/fakeBeaver.js';
import { answeredRun, approvalFrame, endlessRun, HOLM_ANSWER, holmThread, OTHER, T, questionOf } from '../helpers/cli.js';

const R = '11111111-2222-4333-8444-555555555555';
const R2 = '99999999-2222-4333-8444-555555555555';

let fake: FakeBeaver | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(
  sim: SimOptions,
  clientOpts: Partial<ClientOptions> = {},
  patch?: (h: Record<string, any>) => void,
  sessionOpts: { answerFloorMs?: number } = {},
) {
  const s = chatSim(sim);
  patch?.(s.handlers);
  fake = await startFakeBeaver(s.handlers);
  const f = fake;
  const client = new BeaverClient({ port: f.port, windowId: 'main-test-1', ...clientOpts });
  let t = 0;
  const clock = {
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const session = new ChatSession(client, { port: f.port, sleep: clock.sleep, now: clock.now, ...sessionOpts });
  const count = (route: string) => f.calls.filter((c) => c.route === route).length;
  const bodies = (route: string) => f.calls.filter((c) => c.route === route).map((c) => c.body);
  return { session, client, clock, sim: s, count, bodies, calls: f.calls };
}

const opts = (over: Partial<AskOptions> = {}): AskOptions => ({
  thread: { new: true },
  text: 'q',
  timeoutMs: 600_000,
  policy: scriptPolicy,
  runId: R,
  ...over,
});

async function thrown(p: Promise<unknown>): Promise<BeaverError> {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(BeaverError);
  return e as BeaverError;
}

function expectError(r: AskResult, code: string) {
  expect(r.status).toBe('error');
  expect(r.error?.code).toBe(code);
  expect(r.error?.next_step).toBeTruthy();
}

/** A new chat whose id appears from the second poll on, as seen live. */
const newChatRun = (texts = ['I’ll look.', 'I’ll look. Found it.']) =>
  answeredRun(texts, {
    frames: [
      { state: 'running', thread_id: null, text: texts[0] },
      ...texts.slice(1).map((text): Frame => ({ state: 'running', text })),
      { state: 'completed', text: texts[texts.length - 1] },
    ],
  });

// ---------------------------------------------------------------------------------------------

describe('send', () => {
  it('a new chat: sends thread_id "new", the run id and the text; the answer and its sources come from thread', async () => {
    const s = await setup({ runs: [newChatRun()] });
    const r = await s.session.ask(opts());
    expect(s.bodies('send')).toEqual([{ thread_id: 'new', text: 'q', run_id: R, window_id: 'main-test-1' }]);
    expect(r.status).toBe('ok');
    expect(r.answer).toBe(HOLM_ANSWER);
    expect(r.references).toBe('Holm, Sune (2023). The Fairness in Algorithmic Fairness. Res Publica, 29(2), 265-281.');
    expect(r.sources).toEqual([
      expect.objectContaining({ n: 1, display_name: 'Holm 2023', item_key: 'PVX9VYC4', library_ref: 'u', zotero_uri: 'zotero://select/library/items/PVX9VYC4' }),
    ]);
    expect(r.thread_id).toBe(NEW_T);
    expect(r.thread_name).toBe('Test chat');
    expect(r.run_id).toBe(R);
    expect(r.sent_run_id).toBe(R);
    expect(s.session.threadId).toBe(NEW_T);
    expect(s.bodies('thread')).toEqual([{ thread_id: NEW_T, run_id: R, window_id: 'main-test-1' }]);
    // Before the chat had an id, status asked by run id alone; afterwards with the chat's id.
    expect(s.bodies('status')[0]).toEqual({ run_id: R, window_id: 'main-test-1' });
    expect(s.bodies('status').at(-1)).toEqual({ run_id: R, thread_id: NEW_T, window_id: 'main-test-1' });
  });

  it('an existing chat: sends its id and names it on every status', async () => {
    const s = await setup({ runs: [answeredRun()] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.bodies('send')[0].thread_id).toBe(T);
    for (const b of s.bodies('status')) expect(b.thread_id).toBe(T);
    expect(r.thread_id).toBe(T);
  });

  it('a fresh UUID names the run when none is given', async () => {
    const s = await setup({ runs: [answeredRun()] });
    const r = await s.session.ask(opts({ runId: undefined }));
    expect(s.bodies('send')[0].run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r.run_id).toBe(s.bodies('send')[0].run_id);
  });

  it('{latest} continues the most recently updated chat; with none it is thread_not_found and nothing is sent', async () => {
    const rows = [
      { id: OTHER, name: 'Older', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', pinned: true, awaiting_input: null },
      { id: T, name: 'Newer', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-19T10:00:00Z', pinned: false, awaiting_input: null },
    ];
    const s = await setup({ threads: rows, runs: [answeredRun()] });
    const r = await s.session.ask(opts({ thread: { latest: true } }));
    expect(r.status).toBe('ok');
    expect(s.bodies('send')[0].thread_id).toBe(T);
    await fake!.close();
    const e = await setup({ threads: [] });
    expect((await thrown(e.session.ask(opts({ thread: { latest: true } })))).code).toBe('thread_not_found');
    expect(e.count('send')).toBe(0);
  });

  const refusals: Array<[string, number, string]> = [
    ['busy_run', 409, 'busy_run'],
    ['busy_draft', 409, 'busy_draft'],
    ['busy_attachments', 409, 'busy_attachments'],
    ['busy_cards', 409, 'busy_cards'],
    ['thread_busy', 409, 'thread_busy'],
    ['thread_conflict', 409, 'thread_conflict'],
    ['thread_not_found', 404, 'thread_not_found'],
    ['thread_other_instance', 409, 'thread_other_instance'],
    ['window_changed', 409, 'window_changed'],
    ['not_authenticated', 401, 'not_authenticated'],
    ['no_window', 503, 'no_window'],
    ['duplicate_run', 409, 'duplicate_run'],
    ['bad_request', 400, 'protocol'],
  ];
  for (const [code, status, mapped] of refusals) {
    it(`a send refused with ${code} throws ${mapped}: nothing was sent, nothing is polled or stopped`, async () => {
      const s = await setup({ runs: [{ ...endlessRun(), send: refusal(code, status) }] });
      const e = await thrown(s.session.ask(opts({ thread: { id: T } })));
      expect(e.code).toBe(mapped);
      expect(s.count('status')).toBe(0);
      expect(s.count('stop')).toBe(0);
    });
  }

  it('passes items and reports unresolved items with a warning', async () => {
    const items = [
      { library_ref: 'u', zotero_key: 'PVX9VYC4' },
      { library_ref: 'g9', zotero_key: 'NOPE0000' },
    ];
    const s = await setup({
      runs: [
        answeredRun(undefined, {
          send: (b: any) => ({
            ok: true,
            thread_id: null,
            run_id: b.run_id,
            started: true,
            unresolved_items: [{ library_ref: 'g9', zotero_key: 'NOPE0000', status: 'library_excluded' }],
          }),
        }),
      ],
    });
    const r = await s.session.ask(opts({ items }));
    expect(s.bodies('send')[0].items).toEqual(items);
    expect(r.unresolved_items).toEqual([{ library_ref: 'g9', item_key: 'NOPE0000', status: 'library_excluded' }]);
    expect(r.warnings).toContain('Some items could not be attached and were not sent: NOPE0000 (library_excluded).');
  });

  it('throws stopped without sending when the signal is already aborted', async () => {
    const s = await setup({ runs: [answeredRun()] });
    const ac = new AbortController();
    ac.abort();
    expect((await thrown(s.session.ask(opts({ signal: ac.signal })))).code).toBe('stopped');
    expect(s.count('send')).toBe(0);
  });
});

describe('send outcome', () => {
  for (const [what, reply] of [
    ['internal (HTTP 500)', refusal('internal', 500)],
    ['a 404 during the request', raw({ status: 404, text: 'No endpoint found' })],
    ['an unreadable answer', raw({ text: '<html>' })],
  ] as const) {
    it(`a send answered with ${what} is an unknown outcome: polled by its run id, not thrown`, async () => {
      const s = await setup({ runs: [answeredRun(undefined, { send: reply })] });
      const r = await s.session.ask(opts({ thread: { id: T } }));
      expect(r.status).toBe('ok');
      expect(s.count('send')).toBe(1);
      expect(s.bodies('status')[0].run_id).toBe(R);
    });
  }

  it('an unknown send whose status says not_started is send_failed', async () => {
    const s = await setup({ runs: [{ send: refusal('internal', 500), frames: [{ state: 'not_started' }] }] });
    expectError(await s.session.ask(opts({ thread: { id: T } })), 'send_failed');
  });

  it('giving up on a send that is still starting keeps the may-have-been-sent warning and says it may still start', async () => {
    const s = await setup({ runs: [{ send: (b: any) => ({ ok: true, thread_id: T, run_id: b.run_id, started: false, unresolved_items: [] }), frames: [{ state: 'starting' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'send_unknown');
    expect(r.warnings).toEqual(expect.arrayContaining([MAYBE_SENT_WARNING, LATE_START_WARNING]));
    expect(r.error!.message).toContain('may still start in Zotero after this command has exited');
    expect(r.error!.next_step).toContain('stop the run there');
  });

  it('a timeout while the send is still starting: timeout, with both warnings', async () => {
    const s = await setup({ runs: [{ send: (b: any) => ({ ok: true, thread_id: T, run_id: b.run_id, started: false, unresolved_items: [] }), frames: [{ state: 'starting' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expectError(r, 'timeout');
    expect(r.warnings).toEqual(expect.arrayContaining([MAYBE_SENT_WARNING, LATE_START_WARNING]));
  });

  it('started:true counts as seen: a following run_not_found is not a send-unknown case', async () => {
    const s = await setup({ runs: [{ frames: [refusal('run_not_found', 404)] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_not_found');
    expect(r.warnings).not.toContain(LATE_START_WARNING);
  });

  it('a run never seen and status window_changed: send_unknown, not "the run continues there"', async () => {
    const s = await setup({ runs: [{ send: refusal('internal', 500), frames: [refusal('window_changed', 409)] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'send_unknown');
    expect(r.error!.message).not.toContain('continues there');
  });

  const notYet = (b: any) => ({ ok: true, thread_id: T, run_id: b.run_id, started: false, unresolved_items: [] });

  it('started:false, then the run starts: the answer follows and nothing is sent twice', async () => {
    const run = answeredRun();
    run.send = notYet;
    run.frames = [{ state: 'starting', thread_id: null, text: '' }, ...run.frames];
    const s = await setup({ runs: [run] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.count('send')).toBe(1);
  });

  it('started:false, then not_started: send_failed, nothing was sent', async () => {
    const s = await setup({ runs: [{ send: notYet, frames: [{ state: 'starting' }, { state: 'not_started' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'send_failed');
    expect(s.count('send')).toBe(1);
    expect(s.count('stop')).toBe(0);
  });

  it('a run still starting after 30 s: one stop by run id, then send_unknown; never a resend', async () => {
    const s = await setup({ runs: [{ send: notYet, frames: [{ state: 'starting' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'send_unknown');
    expect(r.error!.message).toContain('check the Zotero window before sending it again');
    expect(s.bodies('stop')).toEqual([{ run_id: R, thread_id: T, window_id: 'main-test-1' }]);
    expect(s.count('send')).toBe(1);
  });

  it('a send that timed out is followed by its run id: the answer arrives, the may-have-been-sent warning goes', async () => {
    const s = await setup({ runs: [answeredRun()] }, { requestTimeoutMs: 100 }, (h) => {
      const send = h.send;
      h.send = async (b: any, i: number) => {
        await send(b, i);
        return { hang: true };
      };
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(r.warnings).not.toContain(MAYBE_SENT_WARNING);
    expect(s.count('send')).toBe(1);
  });

  it('a send whose answer was lost and whose run Beaver does not know: one stop, send_unknown', async () => {
    const reset: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/send')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return fetch(url, init);
    };
    const s = await setup({ runs: [] }, { fetchImpl: reset });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'send_unknown');
    expect(s.count('stop')).toBe(1);
  });

  it('a refused connection on the send is thrown: certainly not sent', async () => {
    const refused: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const s = await setup({ runs: [] }, { fetchImpl: refused });
    expect((await thrown(s.session.ask(opts()))).code).toBe('zotero_unreachable');
  });

  it('account_changed on the send: the error with the may-have-been-sent warning, no polling', async () => {
    const s = await setup({ runs: [{ ...endlessRun(), send: raw({ status: 409, json: { error_code: 'account_changed' } }) }] });
    const r = await s.session.ask(opts());
    expectError(r, 'account_changed');
    expect(r.warnings).toContain(MAYBE_SENT_WARNING);
    expect(s.count('status')).toBe(0);
  });
});

describe('which run and chat', () => {
  it('a status answer for a newer run (a resume) is adopted: later reads name it; both ids are reported', async () => {
    const s = await setup({
      runs: [
        {
          frames: [{ state: 'running', text: 'A' }, { state: 'running', run_id: R2, text: 'A B' }, { state: 'completed', text: 'A B' }],
          thread: holmThread,
        },
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(r.run_id).toBe(R2);
    expect(r.sent_run_id).toBe(R);
    expect(s.bodies('status').map((b) => b.run_id)).toEqual([R, R, R2]);
    expect(s.bodies('thread')[0].run_id).toBe(R2);
  });

  it('a status answer without a run id is a protocol error after three tries', async () => {
    const s = await setup({ runs: [{ frames: [raw({ json: { ok: true, state: 'running' } })] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'protocol');
    expect(s.count('status')).toBeGreaterThanOrEqual(3);
  });

  it('a new chat: an approval before the chat has its id is answered by run id alone', async () => {
    const s = await setup({
      runs: [{ frames: [approvalFrame('act1', { thread_id: null })], afterAnswer: [{ state: 'running', text: 'Ok.' }, { state: 'completed' }], thread: holmThread }],
    });
    const r = await s.session.ask(opts());
    expect(r.status).toBe('ok');
    expect(s.bodies('approve')).toEqual([
      { run_id: R, kind: 'approval', action_id: 'act1', approved: false, instructions: DECLINE_INSTRUCTION, window_id: 'main-test-1' },
    ]);
    expect(r.thread_id).toBe(NEW_T);
    expect(r.declined_actions).toEqual([{ id: 'act1', type: 'edit_note', status: 'unknown', apply_command: `beaver apply act1 -r ${NEW_T}` }]);
  });

  it('window_changed while polling ends the ask at once, without a stop: the run continues there', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'Part' }, refusal('window_changed', 409)] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'window_changed');
    expect(r.error!.message).toContain(`continue with -r ${T}`);
    expect(r.answer).toBe('Part');
    expect(s.count('stop')).toBe(0);
  });

  it('run_not_found after the run was seen ends the ask without a stop', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running', thread_id: null }, refusal('run_not_found', 404)] }] });
    const r = await s.session.ask(opts());
    expectError(r, 'run_not_found');
    expect(r.error!.message).toContain('may have switched to another chat');
    expect(s.count('stop')).toBe(0);
  });

  for (const [code, status] of [
    ['account_changed', 409],
    ['not_authenticated', 401],
  ] as const) {
    it(`${code} while polling is definitive: no stop`, async () => {
      const s = await setup({ runs: [{ frames: [{ state: 'running' }, refusal(code, status)] }] });
      const r = await s.session.ask(opts({ thread: { id: T } }));
      expectError(r, code);
      expect(s.count('stop')).toBe(0);
    });
  }

  it('our run finished while a newer run of the chat is active and waits on a card: the answer, no approve, no stop', async () => {
    const s = await setup({ runs: [answeredRun(['Done.'], { frames: [{ state: 'running', text: 'Done.' }, { state: 'completed', is_active: false }] })] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(r.run_id).toBe(R);
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(0);
  });

  it('our run is no longer the active run (a newer one is): the timeout stop does not touch the newer run', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'Part' }], stop: { ok: true, stopped: false, run_id: null } }] });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expectError(r, 'timeout');
    expect(r.error!.message).toBe('No answer within 3 s.');
    expect(s.bodies('stop')).toEqual([{ run_id: R, thread_id: T, window_id: 'main-test-1' }]);
  });
});

describe('transient poll errors', () => {
  const flaky = (failures: Frame[], then: Frame[] = [{ state: 'completed', text: 'Done.' }]): SimOptions => ({
    runs: [{ frames: [{ state: 'running' }, ...failures, ...then], thread: holmThread }],
  });

  it('two failed polls are skipped; the answer follows', async () => {
    const s = await setup(flaky([refusal('internal', 500), raw({ status: 503, json: { error_code: 'endpoint_unavailable' } })]));
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
  });

  it('a window that goes away (no_window) three times in a row ends the ask with no_window and one stop attempt', async () => {
    const gone = refusal('no_window', 503);
    const s = await setup(flaky([gone, gone, gone]));
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'no_window');
    expect(s.count('stop')).toBe(1);
  });

  it('a success resets the count of failures', async () => {
    const bad = refusal('internal', 500);
    const s = await setup(flaky([bad, bad, { state: 'running' }, bad, bad]));
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
  });

  it('Zotero unreachable three times: no stop attempt, the stop warning', async () => {
    let n = 0;
    const flakyFetch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/status') && ++n > 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return fetch(url, init);
    };
    const s = await setup({ runs: [endlessRun()] }, { fetchImpl: flakyFetch });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'zotero_unreachable');
    expect(s.count('stop')).toBe(0);
    expect(r.warnings).toContain(STOP_UNCONFIRMED);
    expect(r.thread_id).toBe(T);
  });
});

describe('poll loop', () => {
  it('reports each tool call once, with its label, and the text whenever it changed', async () => {
    const tc = (id: string, name: string, label: string) => ({ id, name, label, returned: false });
    const s = await setup({
      runs: [
        {
          frames: [
            { state: 'running', text: 'A', tool_calls: [tc('c1', 'item_search', 'Item search: "fairness"')] },
            { state: 'running', text: 'A B', tool_calls: [tc('c1', 'item_search', 'Item search: "fairness"'), tc('c2', 'view', 'Viewing pages')] },
            { state: 'completed', text: 'A B' },
          ],
          thread: holmThread,
        },
      ],
    });
    const events: unknown[] = [];
    await s.session.ask(opts({ thread: { id: T }, onProgress: (e) => events.push(e) }));
    expect(events).toEqual([
      { kind: 'text', text: 'A' },
      { kind: 'tool', name: 'item_search', label: 'Item search: "fairness"' },
      { kind: 'text', text: 'A B' },
      { kind: 'tool', name: 'view', label: 'Viewing pages' },
    ]);
  });

  it('finalizing is still running: the answer is read only once the run completed', async () => {
    const s = await setup({ runs: [answeredRun(['Done.'], { frames: [{ state: 'finalizing', text: 'Done.' }, { state: 'finalizing' }, { state: 'completed' }] })] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.count('status')).toBe(3);
  });

  it('a failed run gives run_error naming its error type, with the partial answer without citation tags', async () => {
    const s = await setup({
      runs: [
        {
          frames: [
            { state: 'running', text: 'Part <citation id="u-X"/> one' },
            { state: 'error', error: { type: 'llm_error', message: 'x', is_retryable: false, is_resumable: false } },
          ],
        },
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_error');
    expect(r.error!.message).toBe('The run was stopped or failed (status error, llm_error).');
    expect(r.answer).toBe('Part  one');
    expect(s.count('stop')).toBe(0);
  });

  it('a failed run that Beaver resumes under a new id: the ask follows it to the answer', async () => {
    const err = { type: 'stream_error', message: 'x', is_retryable: true, is_resumable: true };
    const s = await setup({
      runs: [
        {
          frames: [{ state: 'running', text: 'A' }, { state: 'error', error: err }, { state: 'running', run_id: R2, text: 'A' }, { state: 'completed' }],
          thread: holmThread,
        },
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(r.run_id).toBe(R2);
  });

  it('a failed run that Beaver retries as a new run (no link to ours): run_error that says so', async () => {
    const err = { type: 'stream_error', message: 'x', is_retryable: true, is_resumable: false };
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'A' }, { state: 'error', error: err }, refusal('run_not_found', 404)] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_error');
    expect(r.error!.message).toContain('replaced it with a new run');
  });

  it('a recoverable error that stays: run_error after the grace', async () => {
    const err = { type: 'stream_error', message: 'x', is_retryable: true, is_resumable: true };
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'A' }, { state: 'error', error: err }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_error');
    expect(s.count('status')).toBeGreaterThan(3);
  });

  it('a canceled run (stopped in the window) gives run_error with its text', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'Half' }, { state: 'canceled' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_error');
    expect(r.error!.message).toContain('status canceled');
    expect(r.answer).toBe('Half');
  });

  it('a run reported as running but no longer active ends with run_error instead of waiting for the timeout', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running', text: 'A' }, { state: 'running', is_active: false }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'run_error');
    expect(r.error!.message).toContain('without finishing');
  });

  it('a failing thread read after completion gives the error with the final text, not a crash', async () => {
    const s = await setup({
      runs: [{ frames: [{ state: 'completed', text: 'Head. Final <citation id="u-X"/>.', final_text: 'Final <citation id="u-X"/>.' }], thread: refusal('internal', 500) }],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'protocol');
    expect(r.answer).toBe('Final.');
  });

  it('a thread read with no answer block: the answer comes from the run text, with the known names and a warning', async () => {
    const s = await setup({
      runs: [{ frames: [{ state: 'completed', text: 'x', final_text: 'Holm says so <citation id="u-PVX9VYC4"/>.' }], thread: (b: any) => ({ ...holmThread(b), blocks: [] }) }],
    });
    const r = await s.session.ask(opts({ thread: { id: T }, nameOf: (id) => (id === 'u-PVX9VYC4' ? 'Holm 2023' : null) }));
    expect(r.status).toBe('ok');
    expect(r.answer).toBe('Holm says so (Holm 2023).');
    expect(r.warnings).toContain(ANSWER_FROM_TEXT_WARNING);
  });

  it('no answer block and no final text: protocol, never ok with an empty answer', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'completed', text: '', final_text: '' }], thread: (b: any) => ({ ...holmThread(b), blocks: [] }) }] });
    expectError(await s.session.ask(opts({ thread: { id: T } })), 'protocol');
  });

  it('the final thread read is bounded by --timeout (with a floor): on expiry the answer comes from the run text', async () => {
    const s = await setup(
      { runs: [{ frames: [{ state: 'completed', text: 'x', final_text: 'Final words.' }], thread: raw({ hang: true }) }] },
      {},
      undefined,
      { answerFloorMs: 50 },
    );
    const t0 = Date.now();
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 1 }));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe('ok');
    expect(r.answer).toBe('Final words.');
    expect(r.warnings).toContain(ANSWER_FROM_TEXT_WARNING);
  });

  it('status is ok exactly when error is null', async () => {
    const s = await setup({ runs: [answeredRun()] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status === 'ok').toBe(r.error === null);
  });
});

describe('pauses', () => {
  it('script policy declines an approval with the instruction; it is reported with its apply command', async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          afterAnswer: [
            { state: 'running', text: 'Ok.' },
            { state: 'completed', actions: [{ id: 'act1', action_type: 'edit_note', status: 'rejected', toolcall_id: 'tc1' }] },
          ],
        }),
      ],
    });
    const pauses: string[] = [];
    const r = await s.session.ask(opts({ thread: { id: T }, onProgress: (e) => e.kind === 'pause' && pauses.push(e.decision.action) }));
    expect(r.status).toBe('ok');
    expect(s.bodies('approve')).toEqual([
      { run_id: R, thread_id: T, kind: 'approval', action_id: 'act1', approved: false, instructions: DECLINE_INSTRUCTION, window_id: 'main-test-1' },
    ]);
    expect(r.declined_actions).toEqual([{ id: 'act1', type: 'edit_note', status: 'rejected', apply_command: `beaver apply act1 -r ${T}` }]);
    expect(r.warnings).toContain(DECLINED_WARNING);
    expect(pauses).toEqual(['decline']);
  });

  it("an approved change that was applied is in applied_actions, from the run's own actions", async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          afterAnswer: [{ state: 'completed', text: 'Ok.', actions: [{ id: 'act1', action_type: 'edit_note', status: 'applied', toolcall_id: 'tc1' }] }],
        }),
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: async () => ({ action: 'approve' }) }));
    expect(s.bodies('approve')[0]).toMatchObject({ kind: 'approval', action_id: 'act1', approved: true });
    expect(s.bodies('approve')[0]).not.toHaveProperty('instructions');
    expect(r.applied_actions).toEqual([{ id: 'act1', type: 'edit_note', status: 'applied' }]);
    expect(r.declined_actions).toEqual([]);
  });

  it('a declined change that the person approved in the window counts as applied only', async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          afterAnswer: [{ state: 'completed', text: 'Ok.', actions: [{ id: 'act1', action_type: 'edit_note', status: 'applied', toolcall_id: 'tc1' }] }],
        }),
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.applied_actions).toHaveLength(1);
    expect(r.declined_actions).toEqual([]);
    expect(r.warnings).not.toContain(DECLINED_WARNING);
  });

  it('cancels a question', async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [{ state: 'awaiting_input', questions: [questionOf('tq')] }],
          afterAnswer: [{ state: 'completed', text: 'Ok.' }],
        }),
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.bodies('approve')[0]).toMatchObject({ kind: 'question', toolcall_id: 'tq', cancelled: true });
  });

  const credits = { confirmation_id: 'cc1', title: 'More credits', message: 'This needs more.', pending_credits: 5 };

  it('a declined credit confirmation stops the run and ends with run_error', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'awaiting_input', credit_confirmations: [credits] }], afterAnswer: [{ state: 'running' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(s.bodies('approve')[0]).toMatchObject({ kind: 'credits', confirmation_id: 'cc1', approved: false });
    expectError(r, 'run_error');
    expect(r.error!.message).toBe('The run needs a credit confirmation (5 credits): This needs more.');
    expect(s.count('stop')).toBe(1);
  });

  it('a build that takes question and credit answers only in the window (bad_request): stop, unsupported_pause', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'awaiting_input', credit_confirmations: [credits] }], approve: refusal('bad_request', 400) }] });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: async () => ({ action: 'confirm_credits' }) }));
    expectError(r, 'unsupported_pause');
    expect(r.error!.message).toContain('only in the Zotero window');
    expect(s.count('stop')).toBe(1);
  });

  it('an approval Beaver refuses to apply (excluded library) is declined once instead; the run goes on', async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          approve: (b: any) => (b.approved ? refusal('library_excluded', 409, 'This change is in an excluded library') : { ok: true, delivered: true }),
          afterAnswer: [{ state: 'completed', text: 'Ok.' }],
        }),
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: async () => ({ action: 'approve' }) }));
    expect(r.status).toBe('ok');
    expect(s.bodies('approve').map((b) => b.approved)).toEqual([true, false]);
    expect(r.declined_actions.map((a) => a.id)).toEqual(['act1']);
    expect(r.warnings.some((w) => w.includes('excluded from Beaver'))).toBe(true);
    expect(s.count('stop')).toBe(0);
  });

  it('a pause policy that throws ends the ask with protocol and its message, not a timeout', async () => {
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')] }] });
    const r = await s.session.ask(
      opts({
        thread: { id: T },
        policy: async () => {
          throw new Error('policy broke');
        },
      }),
    );
    expectError(r, 'protocol');
    expect(r.error!.message).toContain('policy broke');
    expect(s.count('approve')).toBe(0);
  });

  it('after an answered pause, nothing listed for good: unsupported_pause once the answer grace and 15 s have passed', async () => {
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')], afterAnswer: [{ state: 'awaiting_input' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'unsupported_pause');
    expect(r.error!.message).toContain('batch approval');
    expect(s.clock.now()).toBeGreaterThanOrEqual(25_000);
  });

  it('a parked run stops the ask with unsupported_pause', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'running' }, { state: 'parked' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'unsupported_pause');
    expect(r.error!.message).toContain('put aside');
  });

  it('waiting on input that status does not list, for 15 s: stop and unsupported_pause', async () => {
    const s = await setup({ runs: [{ frames: [{ state: 'awaiting_input' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expectError(r, 'unsupported_pause');
    expect(r.error!.message).toContain('batch approval');
    expect(s.count('stop')).toBe(1);
  });

  it('waiting after an answered pause (here or in the window) is not unlisted input: no stop, the answer follows', async () => {
    const waiting = Array.from({ length: 30 }, (): Frame => ({ state: 'awaiting_input' }));
    const s = await setup({ runs: [answeredRun(['Ok.'], { frames: [approvalFrame('act1')], afterAnswer: [...waiting, { state: 'running', text: 'Ok.' }, { state: 'completed' }] })] });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.count('stop')).toBe(0);
    await fake!.close();
    const t = await setup({ runs: [answeredRun(['Ok.'], { frames: [approvalFrame('act1'), approvalFrame('act1'), ...waiting, { state: 'running', text: 'Ok.' }, { state: 'completed' }] })] });
    const elsewhere = await t.session.ask(opts({ thread: { id: T }, policy: () => new Promise(() => {}) }));
    expect(elsewhere.status).toBe('ok');
    expect(t.count('stop')).toBe(0);
    expect(t.count('approve')).toBe(0);
  });

  it('a decision that does not fit the pause is treated as stop', async () => {
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: async () => ({ action: 'confirm_credits' }) }));
    expectError(r, 'unsupported_pause');
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(1);
  });

  it('an answer that is still pending 10 s later counts as not delivered: stop, unsupported_pause', async () => {
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')], afterAnswer: [approvalFrame('act1')] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: async () => ({ action: 'approve' }) }));
    expectError(r, 'unsupported_pause');
    expect(r.error!.message).toBe('Beaver did not accept the answer to a pending approval.');
    expect(s.count('approve')).toBe(1);
    expect(s.count('stop')).toBe(1);
  });

  it('action_not_pending (answered in the window meanwhile) is not an error: polling goes on', async () => {
    const s = await setup({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1'), approvalFrame('act1'), { state: 'running' }, { state: 'completed', text: 'Ok.' }],
          approve: refusal('action_not_pending', 409),
        }),
      ],
    });
    const r = await s.session.ask(opts({ thread: { id: T } }));
    expect(r.status).toBe('ok');
    expect(s.count('stop')).toBe(0);
    expect(r.declined_actions).toEqual([]);
  });

  it('a decision that arrives after the deadline is discarded', async () => {
    let s: Awaited<ReturnType<typeof setup>>;
    s = await setup({ runs: [{ frames: [approvalFrame('act1')] }] });
    const late: PausePolicy = async () => {
      s.clock.advance(10_000);
      return { action: 'approve' };
    };
    const r = await s.session.ask(opts({ thread: { id: T }, policy: late, timeoutMs: 5_000 }));
    expectError(r, 'timeout');
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(1);
  });

  it('a policy that never answers ends at the deadline with the run stopped; its signal is not "answered elsewhere"', async () => {
    let got: AbortSignal | undefined;
    const waiting: PausePolicy = (_p, signal) => {
      got = signal;
      return new Promise(() => {});
    };
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: waiting, timeoutMs: 5_000 }));
    expectError(r, 'timeout');
    expect(r.error!.message).toBe('No answer within 5 s. The run was stopped.');
    expect(s.count('approve')).toBe(0);
    expect(got?.aborted).toBe(true);
    expect(got?.reason).not.toBe(PAUSE_ANSWERED_ELSEWHERE);
  });

  it('a pause answered in the window while the policy waits: the policy is released and polling goes on to the answer', async () => {
    let got: AbortSignal | undefined;
    const waiting: PausePolicy = (_p, signal) => {
      got = signal;
      return new Promise(() => {});
    };
    const s = await setup({
      runs: [answeredRun(['Ok.'], { frames: [approvalFrame('act1'), approvalFrame('act1'), { state: 'running', text: 'Ok.' }, { state: 'completed' }] })],
    });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: waiting }));
    expect(r.status).toBe('ok');
    expect(got?.reason).toBe(PAUSE_ANSWERED_ELSEWHERE);
    expect(s.count('approve')).toBe(0);
  });

  it('the window shows another chat while the policy waits: window_changed, nothing answered or stopped', async () => {
    const s = await setup({ runs: [{ frames: [approvalFrame('act1'), approvalFrame('act1'), refusal('window_changed', 409)] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, policy: () => new Promise(() => {}) }));
    expectError(r, 'window_changed');
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(0);
  });
});

describe('own stop, timeout and abort', () => {
  it('timeout: one stop of our run, partial answer without citation tags', async () => {
    const s = await setup({ runs: [endlessRun()] });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expectError(r, 'timeout');
    expect(r.error!.message).toBe('No answer within 3 s. The run was stopped.');
    expect(r.answer).toBe('Partial  answer');
    expect(s.bodies('stop')).toEqual([{ run_id: R, thread_id: T, window_id: 'main-test-1' }]);
  });

  it('stop verification polls until the run is no longer active, without a second stop', async () => {
    const s = await setup({ runs: [{ ...endlessRun(), afterStop: [{ state: 'running' }, { state: 'running' }, { state: 'canceled' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expect(r.error!.message).toContain('The run was stopped.');
    expect(s.count('stop')).toBe(1);
    expect(r.warnings).not.toContain(STOP_UNCONFIRMED);
  });

  it('a run still going 5 s after the stop adds STOP_UNCONFIRMED and claims no stop', async () => {
    const s = await setup({ runs: [{ ...endlessRun(), afterStop: [{ state: 'running' }] }] });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expect(r.error!.message).toBe('No answer within 3 s.');
    expect(r.warnings).toContain(STOP_UNCONFIRMED);
    expect(s.count('stop')).toBe(1);
  });

  it('a stop that answers with a newer run id adopts it', async () => {
    const s = await setup({ runs: [{ ...endlessRun(), stop: { ok: true, stopped: true, run_id: R2 } }] }, {}, (h) => {
      const status = h.status;
      h.status = (b: any, i: number) =>
        b.run_id === R2 ? { json: { ok: true, run_id: R2, thread_id: T, state: 'canceled', is_active: false, text: '' } } : status(b, i);
    });
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expect(r.run_id).toBe(R2);
    expect(r.error!.message).toContain('The run was stopped.');
  });

  it('completion wins a race with the timeout: the normal answer', async () => {
    const s = await setup(
      { runs: [{ frames: [{ state: 'running', text: 'Done.' }], stop: { ok: true, stopped: false, run_id: null }, thread: holmThread }] },
      {},
      (h) => {
        const status = h.status;
        h.status = (b: any, i: number) =>
          i >= 4 ? { json: { ok: true, run_id: R, thread_id: T, state: 'completed', is_active: false, text: 'Done.' } } : status(b, i);
      },
    );
    const r = await s.session.ask(opts({ thread: { id: T }, timeoutMs: 3_000 }));
    expect(r.status).toBe('ok');
    expect(r.answer).toBe(HOLM_ANSWER);
  });

  it('abort during a run: one stop, error stopped, partial answer kept', async () => {
    const ac = new AbortController();
    const s = await setup({
      runs: [{ frames: [{ state: 'running', text: 'Partial' }, () => (ac.abort(), { state: 'running', text: 'Partial more' })] }],
    });
    const r = await s.session.ask(opts({ thread: { id: T }, signal: ac.signal }));
    expectError(r, 'stopped');
    expect(r.error!.message).toBe('Cancelled. The run was stopped.');
    expect(r.answer.startsWith('Partial')).toBe(true);
    expect(s.count('stop')).toBe(1);
  });

  it('abort while the policy is deciding: no answer is sent, the run is stopped', async () => {
    const ac = new AbortController();
    const s = await setup({ runs: [{ frames: [approvalFrame('act1')] }] });
    const r = await s.session.ask(
      opts({
        thread: { id: T },
        signal: ac.signal,
        policy: () => {
          setTimeout(() => ac.abort(), 5);
          return new Promise(() => {});
        },
      }),
    );
    expectError(r, 'stopped');
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(1);
  });
});

describe('session commands', () => {
  it('stop() stops whatever runs in the bound chat, by thread id, and reports how it ended; nothing without a chat', async () => {
    const s = await setup({}, {}, (h) => {
      h.stop = (_b: any, i: number) => ({ json: i === 0 ? { ok: true, stopped: true, run_id: R } : { ok: true, stopped: false, run_id: null } });
      h.status = () => ({ json: { ok: true, run_id: R, thread_id: T, state: 'canceled', is_active: false } });
    });
    expect(await s.session.stop()).toEqual({ outcome: 'not_running', status: null });
    expect(s.count('stop')).toBe(0);
    s.session.threadId = T;
    expect(await s.session.stop()).toEqual({ outcome: 'confirmed', status: 'canceled' });
    expect(s.bodies('stop')[0]).toEqual({ thread_id: T, window_id: 'main-test-1' });
    expect(await s.session.stop()).toEqual({ outcome: 'not_running', status: null });
  });

  it('stop() reports unconfirmed when the run is still active 5 s later', async () => {
    const s = await setup({}, {}, (h) => {
      h.stop = () => ({ json: { ok: true, stopped: true, run_id: R } });
      h.status = () => ({ json: { ok: true, run_id: R, thread_id: T, state: 'running', is_active: true } });
    });
    s.session.threadId = T;
    expect((await s.session.stop()).outcome).toBe('unconfirmed');
  });

  it('transcript() opens the bound chat first, then renders its blocks', async () => {
    const s = await setup({ thread: fixture('thread-full') });
    await expect(s.session.transcript()).rejects.toMatchObject({ code: 'usage' });
    s.session.threadId = T;
    const t = await s.session.transcript();
    expect(s.calls.map((c) => c.route)).toEqual(['open', 'thread']);
    expect(t.title).toBe('Example chat about algorithmic fairness');
    expect(t.body).toContain('> **User:** In one sentence: what is one paper in my library about algorithmic fairness? Cite it.');
    expect(t.body).toContain('*Item search: "algorithmic fairness" (5 results)*');
    expect(t.body).toContain('can be understood. (Holm 2023)');
    expect(t.body.trimEnd().endsWith('OK')).toBe(true);
    expect(t.references).toContain('Holm, Sune (2023)');
  });

  it('open() binds the chat; a busy window refuses and leaves the binding alone', async () => {
    const s = await setup({ open: (_b: any, i: number) => (i === 0 ? { ok: true, thread_id: T, switched: true } : refusal('busy_draft', 409)) });
    expect(await s.session.open({ id: T })).toBe(T);
    expect(s.session.threadId).toBe(T);
    expect((await thrown(s.session.open({ id: OTHER }))).code).toBe('busy_draft');
    expect(s.session.threadId).toBe(T);
  });

  it('apply() opens the chat, then applies the change', async () => {
    const s = await setup({});
    expect(await s.session.apply(T, 'act1')).toEqual({ ok: true, applied: ['act1'], failed: [] });
    expect(s.calls.map((c) => [c.route, c.body])).toEqual([
      ['open', { thread_id: T, window_id: 'main-test-1' }],
      ['apply', { thread_id: T, action_id: 'act1', window_id: 'main-test-1' }],
    ]);
  });
});

describe('stripCitationTags', () => {
  it('keeps a bare < at the end and a < inside the text; drops a cut-off tag', () => {
    expect(stripCitationTags('x <')).toBe('x <');
    expect(stripCitationTags('a < b')).toBe('a < b');
    expect(stripCitationTags('if a <')).toBe('if a <');
    expect(stripCitationTags('text <c')).toBe('text');
    expect(stripCitationTags('text <citat')).toBe('text');
    expect(stripCitationTags('text <citation id="1" ')).toBe('text');
  });
});
