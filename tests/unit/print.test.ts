import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { localTime } from '../../src/modes/chats.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { DECLINE_INSTRUCTION } from '../../src/core/policy.js';
import { chatSim, NEW_T, raw, refusal, startFakeBeaver, type FakeBeaver, type SimOptions } from '../helpers/fakeBeaver.js';
import { answeredRun, approvalFrame, capture, endlessRun, HOLM_ANSWER, T } from '../helpers/cli.js';

const ZERO = '00000000-0000-4000-8000-000000000000';

let fake: FakeBeaver | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(sim: SimOptions = { runs: [answeredRun()] }) {
  fake = await startFakeBeaver(chatSim(sim).handlers);
  const f = fake;
  const count = (route: string) => f.calls.filter((c) => c.route === route).length;
  const bodyOf = (route: string, i = 0) => f.calls.filter((c) => c.route === route)[i]?.body;
  return { port: f.port, count, bodyOf, calls: f.calls };
}

/** Runs the command against the fake with a short poll interval. */
async function cli(port: number, args: string[], over: Parameters<typeof capture>[0] = {}) {
  const cap = capture(over);
  const code = await runCli([...args, '--port', String(port)], cap.io, { pollMs: 5 });
  return { code, out: cap.stdout(), err: cap.stderr() };
}

const oneJson = (out: string) => {
  expect(out.endsWith('\n')).toBe(true);
  expect(out.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out);
};

async function closedPort(): Promise<number> {
  const f = await startFakeBeaver({});
  const p = f.port;
  await f.close();
  return p;
}

describe('script mode: results', () => {
  it('a new chat with --json prints one object with the answer and the source, exit 0', async () => {
    const s = await start();
    const r = await cli(s.port, ['-p', 'q', '--json']);
    expect(r.code).toBe(0);
    const j = oneJson(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.status).toBe('ok');
    expect(j.answer).toBe(HOLM_ANSWER);
    expect(j.sources).toHaveLength(1);
    expect(j.sources[0].item_key).toBe('PVX9VYC4');
    expect(j.thread_id).toBe(NEW_T);
    expect(j.run_id).toBe(s.bodyOf('send').run_id);
    expect(j.sent_run_id).toBe(j.run_id);
    expect(j.error).toBeNull();
    expect(s.bodyOf('send')).toMatchObject({ thread_id: 'new', text: 'q', window_id: 'main-test-1' });
    expect(s.calls[0].route).toBe('info');
  });

  it('text mode: answer and Sources on stdout, Chat on stderr', async () => {
    const s = await start();
    const r = await cli(s.port, ['-p', 'q']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith(`${HOLM_ANSWER}\n\nSources:\n`)).toBe(true);
    expect(r.out).toContain('\n\nSources:\n[1] ');
    expect(r.out).toContain('zotero://select/library/items/PVX9VYC4');
    expect(r.out).not.toContain('Chat:');
    expect(r.err).toBe(`Chat: ${NEW_T}\n`);
  });

  it('both -p --json "q" and -p "q" --json parse', async () => {
    for (const args of [['-p', '--json', 'q'], ['-p', 'q', '--json']]) {
      const s = await start();
      const r = await cli(s.port, args);
      expect(oneJson(r.out).status).toBe('ok');
      expect(s.bodyOf('send').text).toBe('q');
      await fake!.close();
      fake = undefined;
    }
  });

  it('a pending approval is declined with DECLINE_INSTRUCTION and listed in declined_actions', async () => {
    const s = await start({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          afterAnswer: [{ state: 'completed', text: 'Ok.', actions: [{ id: 'act1', action_type: 'edit_note', status: 'rejected', toolcall_id: 'tc1' }] }],
        }),
      ],
    });
    const r = await cli(s.port, ['-p', 'q', '--json']);
    expect(r.code).toBe(0);
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'approval', action_id: 'act1', approved: false, instructions: DECLINE_INSTRUCTION });
    expect(oneJson(r.out).declined_actions).toEqual([{ id: 'act1', type: 'edit_note', status: 'rejected', apply_command: `beaver apply act1 -r ${NEW_T}` }]);
  });

  it('text mode reports applied and declined changes and warnings on stderr', async () => {
    const s = await start({
      runs: [
        answeredRun(['Ok.'], {
          frames: [approvalFrame('act1')],
          afterAnswer: [{ state: 'completed', text: 'Ok.', actions: [{ id: 'act1', action_type: 'edit_note', status: 'rejected', toolcall_id: 'tc1' }] }],
        }),
      ],
    });
    const r = await cli(s.port, ['-p', 'q']);
    expect(r.err).toContain(`Declined: edit_note (act1). Apply it with: beaver apply act1 -r ${NEW_T}`);
    expect(r.out).not.toContain('Declined');
  });

  it('a run that ends in an error prints the partial answer, then message and Next on stderr', async () => {
    const s = await start({
      runs: [
        {
          frames: [
            { state: 'running', text: 'Holm’s (2023) paper <citation id="u-PVX9VYC4"/>' },
            { state: 'error', error: { type: 'server_error', message: 'x', is_retryable: false, is_resumable: false } },
          ],
        },
      ],
    });
    const r = await cli(s.port, ['-p', 'q']);
    expect(r.code).toBe(EXIT_CODES.run_error);
    expect(r.out).toContain('Holm’s (2023)');
    expect(r.err).toMatch(/beaver: The run was stopped or failed \(status error, server_error\)\.\nNext: /);
  });
});

describe('script mode: thread, items and prompt source', () => {
  it('-r <id> sends into that chat, with no open first', async () => {
    const s = await start();
    const r = await cli(s.port, ['-p', 'q', '-r', T, '--json']);
    expect(oneJson(r.out).status).toBe('ok');
    expect(s.bodyOf('send')).toMatchObject({ thread_id: T });
    expect(s.count('open')).toBe(0);
  });

  it('-c sends into the most recently updated saved chat', async () => {
    const row = (id: string, updated_at: string) => ({ id, name: id, created_at: updated_at, updated_at, pinned: false, awaiting_input: null });
    const s = await start({ runs: [answeredRun()], threads: [row('older', '2026-11-01T00:00:00Z'), row(T, '2026-11-19T00:00:00Z')] });
    await cli(s.port, ['-p', 'q', '-c', '--json']);
    expect(s.bodyOf('send')).toMatchObject({ thread_id: T });
  });

  it('-c with no saved chat is thread_not_found (exit 14) and sends nothing', async () => {
    const s = await start({ threads: [] });
    const r = await cli(s.port, ['-p', 'q', '-c', '--json']);
    expect(r.code).toBe(14);
    expect(s.count('send')).toBe(0);
  });

  it('--item KEY and --item g<id>:KEY are sent as library refs', async () => {
    const s = await start();
    await cli(s.port, ['-p', 'q', '--item', 'ABCD1234', '--item', 'g12:WXYZ5678', '--json']);
    expect(s.bodyOf('send').items).toEqual([
      { library_ref: 'u', zotero_key: 'ABCD1234' },
      { library_ref: 'g12', zotero_key: 'WXYZ5678' },
    ]);
  });

  it('reads the prompt from stdin when there is no argument', async () => {
    const s = await start();
    const r = await cli(s.port, ['-p', '--json'], { stdinText: 'question from stdin\n' });
    expect(oneJson(r.out).status).toBe('ok');
    expect(s.bodyOf('send').text).toBe('question from stdin');
  });

  it('never reads stdin when a prompt argument is given (a pipe that never ends does not hang)', async () => {
    const s = await start();
    const stdin = new PassThrough(); // never written to, never ended
    let reads = 0;
    stdin.on('newListener', (ev) => {
      if (ev === 'data' || ev === 'readable') reads++;
    });
    const r = await cli(s.port, ['-p', 'q', '--json'], { stdin });
    expect(oneJson(r.out).status).toBe('ok');
    expect(reads).toBe(0);
  });

  it('an abort while the prompt is read from a pipe that never ends lets go of the stream', async () => {
    const stdin = new PassThrough(); // the producer keeps it open
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await cli(1, ['-p', '--json'], { stdin, signal: ac.signal });
    expect(r.code).toBe(18);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.destroyed).toBe(true);
  });

  it('-p with no prompt on a terminal is a usage error (exit 2)', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const r = await cli(1, ['-p', '--json'], { stdin });
    expect(r.code).toBe(2);
    expect(oneJson(r.out).error.code).toBe('usage');
  });

  it('-c together with -r is a usage error (exit 2) and sends nothing', async () => {
    const s = await start();
    const r = await cli(s.port, ['-p', 'q', '-c', '-r', 'x', '--json']);
    expect(r.code).toBe(2);
    expect(oneJson(r.out).error.code).toBe('usage');
    expect(s.calls).toHaveLength(0);
  });
});

describe('script mode: one JSON object in every case', () => {
  it('an unknown flag with --json gives one usage object and exit 2', async () => {
    const r = await cli(1, ['-p', 'q', '--bogus', '--json']);
    expect(r.code).toBe(2);
    const j = oneJson(r.out);
    expect(j.error.code).toBe('usage');
    expect(j.error.message).toContain('--bogus');
    expect(j.status).toBe('error');
    expect(r.err).toBe('');
  });

  it('an unknown flag without --json writes the message and a next step to stderr', async () => {
    const r = await cli(1, ['-p', 'q', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('--bogus');
    expect(r.err).toContain('Next:');
  });

  it('an unexpected exception gives code protocol without a stack trace', async () => {
    const stdin = new PassThrough();
    stdin.destroy(new Error('boom'));
    const r = await cli(1, ['-p', '--json'], { stdin });
    const j = oneJson(r.out);
    expect(j.error.code).toBe('protocol');
    expect(j.error.message).toContain('boom');
    expect(r.out).not.toContain('    at ');
    expect(r.code).toBe(EXIT_CODES.protocol);
  });

  it('an invalid --item with --json is one usage object', async () => {
    const r = await cli(1, ['-p', 'q', '--item', 'not a key!', '--json']);
    expect(r.code).toBe(2);
    expect(oneJson(r.out).error.code).toBe('usage');
  });

  it('an invalid port from the environment is a usage error', async () => {
    const cap = capture({ env: { BEAVER_PORT: 'abc' } });
    const code = await runCli(['-p', 'q', '--json'], cap.io);
    expect(code).toBe(2);
    expect(oneJson(cap.stdout()).error.code).toBe('usage');
  });

  it('BEAVER_PORT is used when --port is absent', async () => {
    const s = await start();
    const cap = capture({ env: { BEAVER_PORT: String(s.port) } });
    const code = await runCli(['-p', 'q', '--json'], cap.io, { pollMs: 5 });
    expect(code).toBe(0);
  });
});

describe('script mode: failures and exit codes', () => {
  for (const code of ['busy_run', 'busy_draft', 'busy_attachments', 'busy_cards', 'thread_busy', 'thread_conflict']) {
    it(`a window in use (${code}) gives exit 13 with a next step; nothing else is called`, async () => {
      const s = await start({ runs: [{ ...endlessRun(), send: refusal(code, 409, 'The window is in use') }] });
      const r = await cli(s.port, ['-p', 'q', '--json']);
      expect(r.code).toBe(13);
      const j = oneJson(r.out);
      expect(j.error.code).toBe(code);
      expect(j.error.next_step.length).toBeGreaterThan(0);
      expect(j.answer).toBe('');
      expect(j.thread_id).toBeNull();
      expect(s.calls.map((c) => c.route)).toEqual(['info', 'send']);
    });
  }

  it("a -r value that is not a chat id is thread_not_found before any request; nothing unverified is reported", async () => {
    const s = await start();
    for (const args of [['-p', 'hi', '-r', 'not-a-uuid', '--json'], ['apply', 'act1', '-r', 'not-a-uuid', '--json']]) {
      const r = await cli(s.port, args);
      expect(r.code).toBe(14);
      const j = oneJson(r.out);
      expect(j.error.code).toBe('thread_not_found');
      expect(j.error.message).toBe("'not-a-uuid' is not a chat id.");
      expect(j.thread_id).toBeNull();
    }
    expect(oneJson((await cli(s.port, ['-p', 'hi', '-r', 'not-a-uuid', '--json'])).out)).toMatchObject({ run_id: null, sent_run_id: null });
    expect(s.calls).toHaveLength(0);
  });

  it('an error result reports the chat only once a route confirmed it', async () => {
    const s = await start({ runs: [{ send: raw({ status: 500, json: { ok: false, code: 'internal', message: 'x' } }), frames: [refusal('run_not_found', 404)], stop: { ok: true, stopped: false, run_id: null } }] });
    const j = oneJson((await cli(s.port, ['-p', 'hi', '-r', T, '--json'])).out);
    expect(j.error.code).toBe('send_unknown');
    expect(j.thread_id).toBeNull();
    expect(j.run_id).not.toBeNull();
    expect(j.sent_run_id).toBe(j.run_id);
  });

  it('signed out gives exit 11 with not_authenticated', async () => {
    const s = await start({ info: refusal('not_authenticated', 401) });
    const r = await cli(s.port, ['-p', 'q', '--json']);
    expect(r.code).toBe(11);
    expect(oneJson(r.out).error.code).toBe('not_authenticated');
  });

  it('a Beaver that serves another interface version gives exit 11 and the step to update the command', async () => {
    const s = await start({ info: { ok: true, interface_version: 2, plugin_version: 'x', windows: [], default_window_id: null } });
    const r = await cli(s.port, ['-p', 'q', '--json']);
    expect(r.code).toBe(11);
    expect(oneJson(r.out).error.next_step).toContain('Update the beaver command');
    expect(s.count('send')).toBe(0);
  });

  it('no window gives exit 12; --window names one that info does not list gives exit 12', async () => {
    const s = await start({ info: { ok: true, interface_version: 1, plugin_version: 'x', windows: [], default_window_id: null } });
    expect((await cli(s.port, ['-p', 'q', '--json'])).code).toBe(12);
    await fake!.close();
    const t = await start();
    const r = await cli(t.port, ['-p', 'q', '--window', 'main-other', '--json']);
    expect(r.code).toBe(12);
    expect(t.count('send')).toBe(0);
  });

  it('--window pins that window on every window route', async () => {
    const s = await start({
      runs: [answeredRun()],
      info: { ok: true, interface_version: 1, plugin_version: 'x', windows: [{ id: 'standalone-9', kind: 'standalone', status: 'ready' }], default_window_id: 'standalone-9' },
    });
    await cli(s.port, ['-p', 'q', '--window', 'standalone-9', '--json']);
    for (const c of s.calls.filter((x) => x.route !== 'info')) expect(c.body.window_id).toBe('standalone-9');
  });

  it('a closed port gives exit 10', async () => {
    const r = await cli(await closedPort(), ['-p', 'q', '--json']);
    expect(r.code).toBe(10);
    expect(oneJson(r.out).error.code).toBe('zotero_unreachable');
  });

  it("a 404 (the chat routes are off) gives exit 11 with the step to switch on 'Terminal and script access'", async () => {
    fake = await startFakeBeaver({});
    const r = await cli(fake.port, ['-p', 'q', '--json']);
    expect(r.code).toBe(11);
    const j = oneJson(r.out);
    expect(j.error.code).toBe('beaver_unavailable');
    expect(j.error.next_step).toContain('Terminal and script access');
  });

  it('an unknown -r id gives exit 14 and sends nothing', async () => {
    const s = await start({ runs: [{ ...endlessRun(), send: refusal('thread_not_found', 404, 'No chat with this id') }] });
    const r = await cli(s.port, ['-p', 'q', '-r', ZERO, '--json']);
    expect(r.code).toBe(14);
    expect(oneJson(r.out).error.code).toBe('thread_not_found');
    expect(s.count('status')).toBe(0);
  });

  it('--timeout 1 with a run that never settles gives exit 17 and one stop', async () => {
    const s = await start({ runs: [endlessRun('Holm’s (2023) paper <citation id="u-PVX9VYC4"/>')] });
    const r = await cli(s.port, ['-p', 'q', '--timeout', '1', '--json']);
    expect(r.code).toBe(17);
    const j = oneJson(r.out);
    expect(j.error.code).toBe('timeout');
    expect(j.answer).toBe('Holm’s (2023) paper');
    expect(s.count('stop')).toBe(1);
  });

  it('an abort (Ctrl-C) stops the run, reports the partial answer, exit 18, and lets the stop through', async () => {
    const ac = new AbortController();
    const s = await start({ runs: [{ frames: [{ state: 'running', text: 'Partial' }, () => (ac.abort(), { state: 'running', text: 'Partial answer' })] }] });
    const r = await cli(s.port, ['-p', 'q', '--json'], { signal: ac.signal });
    expect(r.code).toBe(18);
    const j = oneJson(r.out);
    expect(j.error.code).toBe('stopped');
    expect(j.answer.length).toBeGreaterThan(0);
    expect(s.count('stop')).toBe(1);
  });
});

describe('status, windows, threads and apply', () => {
  it('status --json on a closed port prints reachable:false and exits 10', async () => {
    const r = await cli(await closedPort(), ['status', '--json']);
    expect(r.code).toBe(10);
    const j = oneJson(r.out);
    expect(j).toMatchObject({ schema_version: 1, reachable: false, beaver_available: false, plugin_version: null, windows: 0 });
    expect(j.error.code).toBe('zotero_unreachable');
  });

  it('status --json against Beaver reports the plugin, the interface and the windows', async () => {
    const s = await start();
    const r = await cli(s.port, ['status', '--json']);
    expect(r.code).toBe(0);
    expect(oneJson(r.out)).toEqual({
      schema_version: 1,
      reachable: true,
      beaver_available: true,
      plugin_version: '0.27.0-beta.3',
      interface_version: 1,
      default_window_id: 'main-test-1',
      windows: 1,
      error: null,
    });
  });

  it('status on a 404 says Zotero is reachable but Beaver is not available (exit 11)', async () => {
    fake = await startFakeBeaver({});
    const r = await cli(fake.port, ['status', '--json']);
    expect(r.code).toBe(11);
    expect(oneJson(r.out)).toMatchObject({ reachable: true, beaver_available: false, error: { code: 'beaver_unavailable' } });
  });

  it('the three common failures: one message and exactly one next step each, in text and in JSON', async () => {
    const closed = await closedPort();
    const down = await cli(closed, ['-p', 'q']);
    expect(down.code).toBe(10);
    expect(down.err).toBe(
      `beaver: Zotero is not running on this computer, or it does not listen on port ${closed} (ECONNREFUSED).\nNext: Start Zotero on this computer (if it is running and listens on a port other than ${closed}, pass that with --port).\n`,
    );
    fake = await startFakeBeaver({});
    const off = await cli(fake.port, ['-p', 'q', '--json']);
    expect(oneJson(off.out).error).toEqual({
      code: 'beaver_unavailable',
      message: "Beaver's terminal access is switched off, or this Beaver build does not have it.",
      next_step: "In Zotero, open Beaver's settings, go to Advanced and switch on 'Terminal and script access'; if that row is missing, the installed Beaver build does not include it.",
    });
    await fake.close();
    const s = await start({ info: raw({ status: 401, json: { error_code: 'not_authenticated' } }) });
    const out = await cli(s.port, ['-p', 'q']);
    expect(out.code).toBe(11);
    expect(out.err).toBe('beaver: Beaver is signed out in Zotero.\nNext: Sign in to Beaver in the Zotero window.\n');
  });

  it('beaver status tells the three apart', async () => {
    const closed = await closedPort();
    const down = await cli(closed, ['status']);
    expect(down.out).toBe(`Zotero: not running (nothing answers on port ${closed})\n`);
    expect(down.err.match(/^Next: /gm)).toHaveLength(1);
    fake = await startFakeBeaver({});
    const off = await cli(fake.port, ['status']);
    expect(off.out).toBe('Zotero: reachable\nBeaver: terminal access off, or not in this build\n');
    expect(off.err.match(/^Next: /gm)).toHaveLength(1);
    await fake.close();
    const s = await start({ info: raw({ status: 401, json: { error_code: 'not_authenticated' } }) });
    const out = await cli(s.port, ['status']);
    expect(out.out).toBe('Zotero: reachable\nBeaver: signed out\n');
    expect(out.code).toBe(11);
    expect(out.err.match(/^Next: /gm)).toHaveLength(1);
  });

  it('status in text mode prints the lines and exits 0', async () => {
    const s = await start();
    const r = await cli(s.port, ['status']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('Zotero: reachable\nBeaver: available (0.27.0-beta.3)\nWindows: 1 (default main-test-1)\n');
  });

  it('windows --json lists the windows and the default', async () => {
    const s = await start();
    const r = await cli(s.port, ['windows', '--json']);
    expect(r.code).toBe(0);
    expect(oneJson(r.out)).toEqual({
      schema_version: 1,
      windows: [{ id: 'main-test-1', kind: 'main', status: 'ready' }],
      default_window_id: 'main-test-1',
      error: null,
    });
  });

  it('windows on a closed port gives one JSON object with the error and exit 10', async () => {
    const r = await cli(await closedPort(), ['windows', '--json']);
    expect(r.code).toBe(10);
    expect(oneJson(r.out)).toMatchObject({ windows: [], error: { code: 'zotero_unreachable' } });
  });

  it('an argument error of status with --json takes the status shape', async () => {
    const r = await cli(1, ['status', '--bogus', '--json']);
    expect(r.code).toBe(2);
    expect(oneJson(r.out)).toMatchObject({ reachable: false, error: { code: 'usage' } });
  });

  const rows = [
    { id: T, name: 'Algorithmic fairness', created_at: '2026-11-18T09:00:00Z', updated_at: '2026-11-19T10:30:00Z', pinned: false, awaiting_input: null },
    { id: ZERO, name: null, created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-02T08:00:00Z', pinned: true, awaiting_input: null },
  ];

  it('threads lists saved chats, numbered, newest first; a query is passed on', async () => {
    const s = await start({ threads: [rows[1], rows[0]] });
    const r = await cli(s.port, ['threads']);
    expect(r.code).toBe(0);
    // Times in this computer's time zone.
    expect(r.out).toBe(`1. Algorithmic fairness  ${localTime('2026-11-19T10:30:00Z')}  ${T}\n2. (untitled)  ${localTime('2026-11-02T08:00:00Z')}  ${ZERO}\n`);
    const q = await cli(s.port, ['threads', 'algorithmic', 'fair', '--json']);
    expect(s.calls.filter((c) => c.route === 'threads').at(-1)!.body).toEqual({ query: 'algorithmic fair', limit: 20 });
    expect(oneJson(q.out)).toMatchObject({ threads: [{ id: T, name: 'Algorithmic fairness', pinned: false }], has_more: false, error: null });
  });

  it('threads --limit is passed on; outside 1–50 it is a usage error before any request', async () => {
    const s = await start({ threads: rows });
    await cli(s.port, ['threads', '--limit', '5']);
    expect(s.calls.find((c) => c.route === 'threads')!.body).toEqual({ limit: 5 });
    const n = s.calls.length;
    for (const bad of ['0', '51', 'x']) {
      const r = await cli(s.port, ['threads', '--limit', bad, '--json']);
      expect(r.code).toBe(2);
      expect(oneJson(r.out)).toMatchObject({ threads: [], error: { code: 'usage' } });
    }
    expect(s.calls).toHaveLength(n);
  });

  it('threads pages on with --after; JSON carries next_cursor, text mode says how to get more', async () => {
    const s = await start({
      routes: {
        threads: (b) => ({
          json: b.after
            ? { ok: true, threads: [rows[1]], next_cursor: null, has_more: false }
            : { ok: true, threads: [rows[0]], next_cursor: 'cur-2', has_more: true },
        }),
      },
    });
    const first = await cli(s.port, ['threads']);
    expect(first.out.trimEnd().split('\n').at(-1)).toBe('More: beaver threads --after cur-2');
    expect(oneJson((await cli(s.port, ['threads', '--json'])).out)).toMatchObject({ has_more: true, next_cursor: 'cur-2' });
    const second = oneJson((await cli(s.port, ['threads', '--after', 'cur-2', '--json'])).out);
    expect(s.calls.filter((c) => c.route === 'threads').at(-1)!.body).toEqual({ limit: 20, after: 'cur-2' });
    expect(second).toMatchObject({ threads: [{ id: ZERO }], has_more: false, next_cursor: null });
    expect(second.threads[0].updated_at).toBe('2026-11-02T08:00:00Z');
  });

  it('threads with no chats says so; on a closed port it gives the threads shape and exit 10', async () => {
    const s = await start({ threads: [] });
    expect((await cli(s.port, ['threads'])).out).toBe('No saved chats.\n');
    const r = await cli(await closedPort(), ['threads', '--json']);
    expect(r.code).toBe(10);
    expect(oneJson(r.out)).toMatchObject({ threads: [], has_more: false, error: { code: 'zotero_unreachable' } });
  });

  it('apply opens the chat, applies the change and reports it', async () => {
    const s = await start();
    const r = await cli(s.port, ['apply', 'act1', '-r', T, '--json']);
    expect(r.code).toBe(0);
    expect(oneJson(r.out)).toEqual({ schema_version: 1, thread_id: T, applied: ['act1'], failed: [], error: null });
    expect(s.calls.map((c) => c.route)).toEqual(['info', 'open', 'apply']);
    const t = await cli(s.port, ['apply', 'act1', '-r', T]);
    expect(t.out).toBe('Applied: act1\n');
  });

  it('apply without -r is a usage error; refusals keep their codes', async () => {
    const s = await start({ apply: refusal('use_approve', 409, 'The run waits on this change; use approve') });
    const u = await cli(s.port, ['apply', 'act1', '--json']);
    expect(u.code).toBe(2);
    expect(oneJson(u.out)).toMatchObject({ applied: [], error: { code: 'usage' } });
    const r = await cli(s.port, ['apply', 'act1', '-r', T, '--json']);
    expect(r.code).toBe(21);
    expect(oneJson(r.out).error.code).toBe('use_approve');
  });

  it('apply that fails for every action is run_error with the reason', async () => {
    const s = await start({ apply: { ok: true, applied: [], failed: [{ action_id: 'act1', error: 'Note not found' }] } });
    const r = await cli(s.port, ['apply', 'act1', '-r', T, '--json']);
    expect(r.code).toBe(16);
    expect(oneJson(r.out).error.message).toContain('Note not found');
  });
});

describe('--json keeps stderr empty', () => {
  it('on success and on failure, stderr is empty and stdout one object', async () => {
    const s = await start();
    const ok = await cli(s.port, ['-p', '--json', 'q']);
    expect(ok.err).toBe('');
    oneJson(ok.out);
    const bad = await cli(await closedPort(), ['-p', 'q', '--json']);
    expect(bad.err).toBe('');
    expect(oneJson(bad.out).status).toBe('error');
  });
});

describe('--help', () => {
  it('names the JSON fields, every exit code and the examples', async () => {
    const r = await cli(1, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('schema_version');
    expect(r.out).toContain('Examples');
    for (const n of [0, 1, ...Object.values(EXIT_CODES)]) expect(r.out).toMatch(new RegExp(`^\\s+${n}\\s`, 'm'));
    for (const word of ['--print', '--json', '--continue', '--resume', '--item', '--timeout', '--port', '--window', 'windows', 'status', 'threads', 'apply', 'sent_run_id', 'Terminal and script access']) {
      expect(r.out).toContain(word);
    }
    expect(r.out).not.toMatch(/guarantee/i);
  });
});
