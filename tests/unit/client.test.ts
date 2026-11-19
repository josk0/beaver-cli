import { afterEach, describe, expect, it } from 'vitest';
import { BeaverClient, connect } from '../../src/client/http.js';
import { BeaverError, ROUTES_OFF_STEP } from '../../src/core/errors.js';
import { chatSim, fixture, startFakeBeaver, WIN, type FakeBeaver, type FakeHandler } from '../helpers/fakeBeaver.js';

let fake: FakeBeaver | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function expectCode(p: Promise<unknown>, code: string): Promise<BeaverError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BeaverError);
    expect((e as BeaverError).code).toBe(code);
    expect((e as BeaverError).nextStep.length).toBeGreaterThan(0);
    return e as BeaverError;
  }
  throw new Error(`expected BeaverError ${code}, got success`);
}

async function clientFor(
  handlers: Record<string, FakeHandler>,
  opts: { windowId?: string; requestTimeoutMs?: number; signal?: AbortSignal } = {},
) {
  fake = await startFakeBeaver(handlers);
  return new BeaverClient({ port: fake.port, ...opts });
}

const R = '11111111-2222-4333-8444-555555555555';
const T = '10000000-0000-4000-8000-000000000001';

describe('transport failures', () => {
  it('maps a closed port to zotero_unreachable, certainly not sent', async () => {
    const f = await startFakeBeaver({});
    const port = f.port;
    await f.close();
    const e = await expectCode(new BeaverClient({ port }).info(), 'zotero_unreachable');
    expect(e.maybeSent).toBe(false);
  });

  it('maps a request timeout to protocol naming the wait and a possible dialog', async () => {
    const c = await clientFor({ info: () => ({ hang: true }) }, { requestTimeoutMs: 50 });
    const e = await expectCode(c.info(), 'protocol');
    expect(e.message).toBe('Zotero did not answer within 0.05 s. A dialog may be open in the Zotero window.');
    expect(e.maybeSent).toBe(true);
  });

  it('gives thread its own, longer budget and a message that does not blame a dialog', async () => {
    fake = await startFakeBeaver({ thread: () => ({ hang: true }) });
    const c = new BeaverClient({ port: fake.port, requestTimeoutMs: 20, threadTimeoutMs: 120 });
    const t0 = Date.now();
    const e = await expectCode(c.thread({ threadId: T }), 'protocol');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(e.message).toBe('Beaver did not finish reading the chat within 0.12 s.');
  });

  it('a port that fetch refuses to use (port 1: "bad port") is zotero_unreachable, named, and certainly not sent', async () => {
    const e = await expectCode(new BeaverClient({ port: 1 }).info(), 'zotero_unreachable');
    expect(e.message).toContain('bad port');
    expect(e.maybeSent).toBe(false);
  });

  it('marks a reset connection as zotero_unreachable that may have been sent', async () => {
    const reset: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    };
    const e = await expectCode(new BeaverClient({ port: 1, fetchImpl: reset }).info(), 'zotero_unreachable');
    expect(e.maybeSent).toBe(true);
  });

  it('maps an abort through the signal to stopped; an aborted signal sends nothing', async () => {
    const ac = new AbortController();
    const c = await clientFor({ info: () => ({ hang: true }) }, { signal: ac.signal, requestTimeoutMs: 5000 });
    const p = c.info();
    setTimeout(() => ac.abort(), 30);
    await expectCode(p, 'stopped');
    const n = fake!.calls.length;
    await expectCode(c.info(), 'stopped');
    expect(fake!.calls).toHaveLength(n);
  });
});

describe('answers that mean the chat routes are off', () => {
  it('a plain-text 404 is beaver_unavailable with the step to switch on the setting', async () => {
    const c = await clientFor({});
    const e = await expectCode(c.info(), 'beaver_unavailable');
    expect(e.nextStep).toBe(ROUTES_OFF_STEP);
    expect(e.nextStep).toContain("'Terminal and script access'");
  });

  it("Zotero's 503 endpoint_unavailable (a route released while Zotero runs) is beaver_unavailable", async () => {
    const c = await clientFor({ status: () => ({ status: 503, json: { error_code: 'endpoint_unavailable' } }) });
    const e = await expectCode(c.status({ runId: R }), 'beaver_unavailable');
    expect(e.serverCode).toBe('endpoint_unavailable');
  });

  it('an interface version other than 1 is beaver_unavailable with the step to update the command', async () => {
    const c = await clientFor({
      info: () => ({ json: { ok: true, interface_version: 2, plugin_version: 'x', windows: [], default_window_id: null } }),
    });
    const e = await expectCode(c.info(), 'beaver_unavailable');
    expect(e.nextStep).toContain('Update the beaver command');
  });
});

describe('refusals map to codes', () => {
  const table: Array<[string, number, string]> = [
    ['not_authenticated', 401, 'not_authenticated'],
    ['bad_request', 400, 'protocol'],
    ['thread_not_found', 404, 'thread_not_found'],
    ['run_not_found', 404, 'run_not_found'],
    ['action_not_found', 404, 'action_not_found'],
    ['busy_run', 409, 'busy_run'],
    ['busy_cards', 409, 'busy_cards'],
    ['busy_draft', 409, 'busy_draft'],
    ['busy_attachments', 409, 'busy_attachments'],
    ['thread_busy', 409, 'thread_busy'],
    ['thread_conflict', 409, 'thread_conflict'],
    ['thread_other_instance', 409, 'thread_other_instance'],
    ['window_changed', 409, 'window_changed'],
    ['action_not_pending', 409, 'action_not_pending'],
    ['use_approve', 409, 'use_approve'],
    ['library_excluded', 409, 'library_excluded'],
    ['duplicate_run', 409, 'duplicate_run'],
    ['account_changed', 409, 'account_changed'],
    ['library_access_changed', 409, 'library_access_changed'],
    ['no_window', 503, 'no_window'],
    ['internal', 500, 'protocol'],
    ['something_new', 409, 'protocol'],
  ];
  for (const [code, status, mapped] of table) {
    it(`${status} ${code} -> ${mapped}, keeping the server code and message`, async () => {
      const c = await clientFor({ open: () => ({ status, json: { ok: false, code, message: 'said by Beaver' } }) });
      const e = await expectCode(c.open(T), mapped);
      expect(e.serverCode).toBe(code);
      if (code !== 'not_authenticated') expect(e.message).toContain('said by Beaver');
    });
  }

  it("the endpoint wrapper's own refusals ({error_code}) map too: 401 signed out, 409 account change", async () => {
    const c = await clientFor({
      threads: () => ({ status: 401, json: { error_code: 'not_authenticated' } }),
      open: () => ({ status: 409, json: { error_code: 'account_changed' } }),
    });
    await expectCode(c.threads(), 'not_authenticated');
    await expectCode(c.open(T), 'account_changed');
  });

  it("a plain-text 400 (Zotero's answer to malformed JSON) is protocol", async () => {
    const c = await clientFor({ info: () => ({ status: 400, text: 'Bad Request' }) });
    await expectCode(c.info(), 'protocol');
  });

  it('an empty or non-JSON 200 body is protocol', async () => {
    const c = await clientFor({ info: (_b, i) => (i === 0 ? { text: '' } : { text: '<html>' }) });
    await expectCode(c.info(), 'protocol');
    await expectCode(c.info(), 'protocol');
  });
});

describe('requests and echo checks', () => {
  it('sends window_id on window routes only', async () => {
    const sim = chatSim({ runs: [{ frames: [{ state: 'running' }] }] });
    const c = await clientFor(sim.handlers, { windowId: WIN });
    await c.info();
    await c.threads({ query: 'fair', limit: 5 });
    await c.open(T);
    await c.send({ threadId: T, text: 'hi', runId: R });
    await c.status({ runId: R, threadId: T });
    await c.stop({ runId: R });
    await c.thread({ threadId: T, runId: R });
    const byRoute = Object.fromEntries(fake!.calls.map((x) => [x.route, x.body]));
    expect(byRoute.info).toEqual({});
    expect(byRoute.threads).toEqual({ query: 'fair', limit: 5 });
    expect(byRoute.open).toEqual({ thread_id: T, window_id: WIN });
    expect(byRoute.send).toEqual({ thread_id: T, text: 'hi', run_id: R, window_id: WIN });
    expect(byRoute.status).toEqual({ run_id: R, thread_id: T, window_id: WIN });
    expect(byRoute.stop).toEqual({ run_id: R, window_id: WIN });
    expect(byRoute.thread).toEqual({ thread_id: T, run_id: R, window_id: WIN });
  });

  it('send passes items; an answer for another run id is protocol', async () => {
    const c = await clientFor({
      send: (b, i) => ({ json: { ok: true, thread_id: null, run_id: i === 0 ? b.run_id : 'other', started: true, unresolved_items: [] } }),
    });
    const items = [{ library_ref: 'u', zotero_key: 'ABCD1234' }];
    await c.send({ threadId: 'new', text: 'q', runId: R, items });
    expect(fake!.calls[0].body.items).toEqual(items);
    await expectCode(c.send({ threadId: 'new', text: 'q', runId: R }), 'protocol');
  });

  it('status accepts any run_id (a resume answers with its own) and refuses an answer without one', async () => {
    const c = await clientFor({
      status: (_b, i) => ({ json: i === 0 ? { ok: true, run_id: 'resumed', state: 'running', is_active: true } : { ok: true, state: 'running', is_active: true } }),
    });
    expect((await c.status({ runId: R })).run_id).toBe('resumed');
    await expectCode(c.status({ runId: R }), 'protocol');
  });

  it('every 2xx answer must say ok:true', async () => {
    const c = await clientFor({ info: () => ({ json: { interface_version: 1, plugin_version: 'x', windows: [], default_window_id: null } }) });
    await expectCode(c.info(), 'protocol');
  });

  it('status needs a known state and a boolean is_active; open needs thread_id and switched; send needs started', async () => {
    const c = await clientFor({
      status: (_b, i) => ({ json: i === 0 ? { ok: true, run_id: R, state: 'thinking', is_active: true } : { ok: true, run_id: R, state: 'running' } }),
      open: (_b, i) => ({ json: i === 0 ? { ok: true, thread_id: 7, switched: true } : { ok: true, thread_id: null } }),
      send: (b) => ({ json: { ok: true, thread_id: null, run_id: b.run_id, unresolved_items: [] } }),
    });
    await expectCode(c.status({ runId: R }), 'protocol');
    await expectCode(c.status({ runId: R }), 'protocol');
    await expectCode(c.open(T), 'protocol');
    await expectCode(c.open('new'), 'protocol');
    await expectCode(c.send({ threadId: 'new', text: 'q', runId: R }), 'protocol');
  });

  it('a threads limit outside 1–50 is a usage error before any request', async () => {
    const c = await clientFor({ threads: () => ({ json: { ok: true, threads: [], next_cursor: null, has_more: false } }) });
    for (const limit of [0, 51, 2.5]) await expectCode(c.threads({ limit }), 'usage');
    expect(fake!.calls).toHaveLength(0);
    await c.threads({ limit: 50 });
    expect(fake!.calls).toHaveLength(1);
  });

  it('stop: stopped:false needs no run id; stopped:true without one is protocol', async () => {
    const c = await clientFor({
      stop: (_b, i) => ({ json: i === 0 ? { ok: true, stopped: false, run_id: null } : { ok: true, stopped: true, run_id: null } }),
    });
    expect(await c.stop({ runId: R })).toEqual({ ok: true, stopped: false, run_id: null });
    await expectCode(c.stop({ runId: R }), 'protocol');
  });

  it('approve sends the answer in the Schema shape', async () => {
    const c = await clientFor({ approve: () => ({ json: { ok: true, delivered: true } }) });
    await c.approve({ runId: R, threadId: T, kind: 'approval', action_id: 'a1', approved: false, instructions: 'Put it in the answer.' });
    await c.approve({ runId: R, kind: 'question', toolcall_id: 'tc1', cancelled: true });
    await c.approve({ runId: R, kind: 'credits', confirmation_id: 'cc1', approved: true });
    expect(fake!.calls.map((x) => x.body)).toEqual([
      { run_id: R, thread_id: T, kind: 'approval', action_id: 'a1', approved: false, instructions: 'Put it in the answer.' },
      { run_id: R, kind: 'question', toolcall_id: 'tc1', cancelled: true },
      { run_id: R, kind: 'credits', confirmation_id: 'cc1', approved: true },
    ]);
  });

  it('thread for another chat is protocol', async () => {
    const c = await clientFor({ thread: () => ({ json: fixture('thread-run-a') }) });
    expect((await c.thread({ threadId: T })).title).toBe('Example chat about algorithmic fairness');
    await expectCode(c.thread({ threadId: 'other' }), 'protocol');
  });
});

describe('connect', () => {
  it('pins the default window from info', async () => {
    fake = await startFakeBeaver(chatSim().handlers);
    const { client, info } = await connect({ port: fake.port });
    expect(client.windowId).toBe(WIN);
    expect(info.plugin_version).toBe('0.27.0-beta.3');
  });

  it('pins --window when info lists it; an unlisted one, or no window at all, is no_window', async () => {
    fake = await startFakeBeaver(
      chatSim({
        info: (_b: unknown, i: number) => ({
          ok: true,
          interface_version: 1,
          plugin_version: 'x',
          windows: i < 2 ? [{ id: 'standalone-1', kind: 'standalone', status: 'ready' }] : [],
          default_window_id: i < 2 ? 'standalone-1' : null,
        }),
      }).handlers,
    );
    expect((await connect({ port: fake.port, windowId: 'standalone-1' })).client.windowId).toBe('standalone-1');
    await expectCode(connect({ port: fake.port, windowId: 'main-9' }), 'no_window');
    await expectCode(connect({ port: fake.port }), 'no_window');
  });
});
