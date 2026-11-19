import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { localTime } from '../../src/modes/chats.js';
import { chatSim, fixture, NEW_T, refusal, startFakeBeaver, type FakeBeaver, type FakeHandler, type SimOptions, type SimRun } from '../helpers/fakeBeaver.js';
import { answeredRun, approvalFrame, capture, endlessRun, T, questionOf } from '../helpers/cli.js';

const ZERO = '00000000-0000-4000-8000-000000000000';
const R = '11111111-2222-4333-8444-555555555555';

let fake: FakeBeaver | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(sim: SimOptions, patch?: (h: Record<string, FakeHandler>) => void) {
  const handlers = chatSim(sim).handlers;
  patch?.(handlers);
  fake = await startFakeBeaver(handlers);
  const f = fake;
  return {
    port: f.port,
    count: (route: string) => f.calls.filter((c) => c.route === route).length,
    bodyOf: (route: string, i = 0) => f.calls.filter((c) => c.route === route)[i]?.body,
    routes: () => f.calls.map((c) => c.route),
    calls: () => f.calls,
  };
}

/** Runs the interactive command with the given input lines, then end of input. */
async function session(port: number, input: string, args: string[] = [], over: Parameters<typeof capture>[0] = {}) {
  const cap = capture({ stdinText: input, ...over });
  const code = await runCli([...args, '--port', String(port)], cap.io, { pollMs: 5 });
  return { code, out: cap.stdout(), err: cap.stderr() };
}

/** Sends `message`, then types `answer` only once `prompt` is on stdout, then ends the input. */
async function answering(port: number, message: string, prompt: string, answer: string) {
  const stdin = new PassThrough();
  const cap = capture({ stdin });
  const done = runCli(['--port', String(port)], cap.io, { pollMs: 5 });
  stdin.write(`${message}\n`);
  await waitFor(() => cap.stdout().includes(prompt));
  stdin.end(`${answer}\n`);
  return { code: await done, out: cap.stdout(), err: cap.stderr() };
}

const tool = { id: 'c1', name: 'item_search_by_topic', label: null, returned: false };
/** A run that calls one tool, writes no streamed text, and answers with the Holm fixture. */
const toolRun = (): SimRun => answeredRun([''], { frames: [{ state: 'running', text: '', tool_calls: [tool] }, { state: 'completed', text: '', tool_calls: [tool] }] });
const answerFirstChat = (): SimOptions => ({ runs: [toolRun(), answeredRun([''])] });

const savedChat = { id: T, name: 'Example chat about algorithmic fairness', created_at: '2026-11-19T09:00:00Z', updated_at: '2026-11-19T10:00:00Z', pinned: false, awaiting_input: null };
/** A saved chat T, the most recent, whose transcript is the two-run fixture. */
const withSavedChat = (over: SimOptions = {}): SimOptions => ({ threads: [savedChat], thread: fixture('thread-full'), runs: [answeredRun([''])], ...over });

describe('interactive: messages', () => {
  it('one question prints the tool line, the answer once and Sources', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, 'what is in my library?\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('· item_search_by_topic');
    expect(r.out.match(/Holm’s \(2023\)/g)).toHaveLength(1);
    expect(r.out).not.toContain('<citation');
    expect(r.out).toContain('Sources:\n[1] ');
    expect(r.out.startsWith('> ')).toBe(true);
    expect(s.bodyOf('send')).toMatchObject({ text: 'what is in my library?', thread_id: 'new' });
    expect(r.err).toContain(`Chat: ${NEW_T}`);
  });

  it('a second message goes to the chat of the first', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, 'one\ntwo\n');
    expect(r.code).toBe(0);
    expect(s.count('send')).toBe(2);
    expect(s.bodyOf('send', 0).thread_id).toBe('new');
    expect(s.bodyOf('send', 1)).toMatchObject({ text: 'two', thread_id: NEW_T });
  });

  it('/new then a message starts a new chat', async () => {
    const s = await start(answerFirstChat());
    await session(s.port, 'one\n/new\ntwo\n');
    expect(s.bodyOf('send', 1)).toMatchObject({ text: 'two', thread_id: 'new' });
  });

  it('a line ending in a backslash continues on the next line', async () => {
    const s = await start(answerFirstChat());
    await session(s.port, 'first line \\\nsecond line\n');
    expect(s.bodyOf('send').text).toBe('first line \nsecond line');
  });

  it('an empty line sends nothing; end of input exits 0 at once', async () => {
    const s = await start(answerFirstChat());
    expect((await session(s.port, '\n   \n')).code).toBe(0);
    expect((await session(s.port, '')).code).toBe(0);
    expect(s.count('send')).toBe(0);
  });

  it('end of input while a run is active lets the run finish and prints its answer', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, 'one\n');
    expect(r.out).toContain('Holm’s (2023)');
  });

  it('/quit leaves without reading further lines', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, '/quit\nlost message\n');
    expect(r.code).toBe(0);
    expect(s.count('send')).toBe(0);
  });
});

describe('interactive: pauses', () => {
  const withApproval = (): SimOptions => ({
    runs: [
      answeredRun([''], {
        frames: [approvalFrame('act1')],
        afterAnswer: [{ state: 'running' }, { state: 'completed', actions: [{ id: 'act1', action_type: 'edit_note', status: 'rejected', toolcall_id: 'tc1' }] }],
      }),
      answeredRun(['']),
    ],
  });

  it('shows the proposed change, and y approves it', async () => {
    const s = await start(withApproval());
    const r = await answering(s.port, 'edit my note', 'Approve? ', 'y');
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'approval', action_id: 'act1', approved: true });
    expect(r.out).toContain('Beaver wants to make a change: edit_note\n  Note u-NOTE1234: replace text\n  - old\n  + new\n');
    expect(r.out).not.toContain('prototype limit');
    expect(r.out).toContain('Approve? [y]es / [n]o / or type an instruction to decline with:');
  });

  it('a change in an excluded library shows no details and offers only decline: even y declines', async () => {
    const s = await start({
      runs: [
        answeredRun([''], {
          frames: [approvalFrame('act1', { approvals: [{ action_id: 'act1', toolcall_id: 'tc1', action_type: 'edit_note', proposed_data: null, current_value: null, excluded: true }] })],
          afterAnswer: [{ state: 'completed' }],
        }),
      ],
    });
    const r = await answering(s.port, 'edit my note', 'Any answer declines it: ', 'y');
    expect(r.out).toContain('(details hidden: the change touches a library excluded from Beaver)');
    expect(r.out).not.toContain('Approve? ');
    expect(s.bodyOf('approve')).toMatchObject({ action_id: 'act1', approved: false });
  });

  it('n declines without an instruction; the decline names its apply command', async () => {
    const s = await start(withApproval());
    const r = await answering(s.port, 'edit my note', 'Approve? ', 'n');
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'approval', action_id: 'act1', approved: false });
    expect(s.bodyOf('approve').instructions).toBeUndefined();
    expect(r.err).toContain(`Declined: edit_note (act1). Apply it with: beaver apply act1 -r ${NEW_T}`);
  });

  it('lines typed before an approval question do not answer it: they are discarded, and end of input declines', async () => {
    const s = await start(withApproval());
    const r = await session(s.port, 'edit my note\ny\n');
    expect(s.bodyOf('approve')).toMatchObject({ action_id: 'act1', approved: false });
    expect(s.calls().filter((c) => c.route === 'approve' && c.body.approved === true)).toHaveLength(0);
    expect(r.out).toContain('Discarded 1 line(s) typed before this question.');
  });

  it('other text declines with that instruction', async () => {
    const s = await start(withApproval());
    await answering(s.port, 'edit my note', 'Approve? ', 'use a note instead');
    expect(s.bodyOf('approve')).toMatchObject({ action_id: 'act1', approved: false, instructions: 'use a note instead' });
  });

  const askRun = (allow = {}) => ({
    runs: [answeredRun([''], { frames: [{ state: 'awaiting_input' as const, questions: [questionOf('tc9', allow)] }], afterAnswer: [{ state: 'completed' as const }] })],
  });

  it('a question shows its options numbered; a number answers it', async () => {
    const s = await start(askRun());
    const r = await answering(s.port, 'compare my papers', 'Answer (', '2');
    expect(r.out).toContain(
      'Beaver has a question:\n  Scope: Which papers should I compare?\n    1. The newest (since 2020)\n    2. The most cited\n    3. All of them\nAnswer (a number from 1 to 3; Enter cancels): ',
    );
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'question', toolcall_id: 'tc9', answers: [{ item_id: 'q0', selected_option_ids: ['q0-o1'] }] });
    expect(s.bodyOf('approve')).not.toHaveProperty('cancelled');
  });

  it('several numbers when the question allows several; free text when it allows an answer of one\'s own', async () => {
    const s = await start(askRun({ allow_multiple: true }));
    await answering(s.port, 'q', 'Answer (', '3, 1 3');
    expect(s.bodyOf('approve').answers).toEqual([{ item_id: 'q0', selected_option_ids: ['q0-o2', 'q0-o0'] }]);
    await fake!.close();
    const t = await start(askRun({ allow_custom: true }));
    await answering(t.port, 'q', 'your own answer', 'only the ones on Rawls');
    expect(t.bodyOf('approve').answers).toEqual([{ item_id: 'q0', selected_option_ids: [], custom_text: 'only the ones on Rawls' }]);
  });

  it('an invalid choice asks again; an empty line or /cancel cancels the question', async () => {
    const s = await start(askRun());
    const stdin = new PassThrough();
    const cap = capture({ stdin });
    const done = runCli(['--port', String(s.port)], cap.io, { pollMs: 5 });
    stdin.write('q\n');
    await waitFor(() => cap.stdout().includes('Answer ('));
    stdin.write('1 2\n');
    await waitFor(() => cap.stdout().includes('Choose one number from 1 to 3.'));
    stdin.end('/cancel\n');
    expect(await done).toBe(0);
    expect(cap.stdout()).toContain('The question was cancelled.');
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'question', toolcall_id: 'tc9', cancelled: true });
    await fake!.close();
    const t = await start(askRun());
    await answering(t.port, 'q', 'Answer (', '');
    expect(t.bodyOf('approve')).toMatchObject({ cancelled: true });
  });

  it('lines typed before a question do not answer it; a question answered in the window releases the prompt', async () => {
    const s = await start(askRun());
    const r = await session(s.port, 'q\n2\n');
    expect(r.out).toContain('Discarded 1 line(s) typed before this question.');
    expect(s.bodyOf('approve')).toMatchObject({ cancelled: true });
    await fake!.close();
    const t = await start({
      runs: [answeredRun([''], { frames: [{ state: 'awaiting_input', questions: [questionOf('tc9')] }, { state: 'awaiting_input', questions: [questionOf('tc9')] }, { state: 'running' }, { state: 'completed' }] })],
    });
    const stdin = new PassThrough();
    const cap = capture({ stdin });
    const done = runCli(['--port', String(t.port)], cap.io, { pollMs: 5 });
    stdin.write('q\n');
    await waitFor(() => cap.stdout().includes('Answered in the Zotero window.'));
    stdin.end();
    expect(await done).toBe(0);
    expect(t.count('approve')).toBe(0);
  });

  it('a credit confirmation shows title, message and credits and asks y/n', async () => {
    const c = { confirmation_id: 'cc1', title: 'Large run', message: 'This run uses many credits.', pending_credits: 40 };
    const s = await start({ runs: [answeredRun([''], { frames: [{ state: 'awaiting_input', credit_confirmations: [c] }], afterAnswer: [{ state: 'completed' }] })] });
    const r = await answering(s.port, 'q', 'Continue? ', 'y');
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'credits', confirmation_id: 'cc1', approved: true });
    expect(r.out).toContain('Large run');
    expect(r.out).toContain('This run uses many credits.');
    expect(r.out).toContain('40');
    expect(r.out).toContain('Continue? [y/n]');
  });

  it('a pause that cannot be answered stops the run and says so', async () => {
    const s = await start({ runs: [{ frames: [{ state: 'running' }, { state: 'parked' }] }] });
    const r = await session(s.port, 'q\n');
    expect(s.count('stop')).toBe(1);
    expect(r.err).toContain('which this command cannot answer');
  });
});

describe('interactive: errors and slash commands', () => {
  it('/threads lists saved chats, numbered; /resume <n> continues one of them', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '/threads\n/resume 1\n/resume 2\n');
    expect(r.out).toContain(`1. Example chat about algorithmic fairness  ${localTime('2026-11-19T10:00:00Z')}  ${T}`);
    expect(r.out).toContain('Continue one with /resume <number>.');
    expect(s.bodyOf('open')).toMatchObject({ thread_id: T });
    expect(r.out).toContain('> **User:** Reply with the single word OK.');
    expect(r.out).toContain('Choose a number from 1 to 1.');
  });

  it('/threads <text> searches; /resume <n> before /threads says what to do', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '/resume 1\n/threads nothing like it\n');
    expect(r.out).toContain('Run /threads first, or give the chat id.');
    expect(s.bodyOf('threads')).toEqual({ query: 'nothing like it', limit: 20 });
    expect(r.out).toContain('No saved chat matches.');
  });

  it('an unknown command names /help', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, '/bogus\n');
    expect(r.out).toContain('Unknown command /bogus. Type /help');
    expect(s.count('send')).toBe(0);
  });

  it('/help lists the commands', async () => {
    const s = await start(answerFirstChat());
    const r = await session(s.port, '/help\n');
    for (const c of ['/new', '/threads', '/resume', '/show', '/status', '/stop', '/quit']) expect(r.out).toContain(c);
    expect(r.out).not.toContain('/current');
  });

  it('a busy window prints Next and the loop goes on to the next input', async () => {
    const busy = { ...endlessRun(), send: refusal('busy_run', 409, 'Beaver is responding in this window') };
    const s = await start({ runs: [busy, busy] });
    const r = await session(s.port, 'one\ntwo\n/help\n');
    expect(r.code).toBe(0);
    expect(r.err.match(/Next: /g)).toHaveLength(2);
    expect(r.err).toContain('beaver: Beaver is responding in this window');
    expect(r.out).toContain('/quit');
    expect(s.count('status')).toBe(0);
  });

  it('/show prints the whole chat; /show before any chat says so', async () => {
    const s = await start(withSavedChat());
    const none = await session(s.port, '/show\n');
    expect(none.out).toContain('No chat yet.');
    const r = await session(s.port, '/show\n', ['-c']);
    expect(r.out).toContain('> **User:** In one sentence');
    expect(r.out).toContain('> **User:** Reply with the single word OK.');
    expect(r.out).toContain('Holm, Sune (2023)');
  });

  it('/status reports Zotero, Beaver and the bound chat', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '/status\n', ['-c']);
    expect(r.out).toContain('Zotero: reachable');
    expect(r.out).toContain('Beaver: available (0.27.0-beta.3)');
    expect(r.out).toContain(`Bound chat: ${T}`);
  });

  it('/stop stops a run in the bound chat that was started in the window; says when there is nothing to stop', async () => {
    const s = await start(withSavedChat());
    const idle = await session(s.port, '/stop\n', ['-c']);
    expect(idle.out).toContain('Nothing to stop in this chat.');
    expect(s.bodyOf('stop')).toEqual({ thread_id: T, window_id: 'main-test-1' });
    await fake!.close();

    const s2 = await start(withSavedChat(), (h) => {
      h.stop = () => ({ json: { ok: true, stopped: true, run_id: R } });
      h.status = () => ({ json: { ok: true, run_id: R, thread_id: T, state: 'canceled', is_active: false } });
    });
    expect((await session(s2.port, '/stop\n', ['-c'])).out).toContain('Stopped.');
    await fake!.close();

    const s3 = await start(answerFirstChat());
    expect((await session(s3.port, '/stop\n')).out).toContain('No chat is bound yet');
  });

  it('/stop while the window shows another chat says that nothing was stopped', async () => {
    const s = await start(withSavedChat(), (h) => {
      h.stop = () => ({ status: 409, json: { ok: false, code: 'window_changed', message: 'The window shows another chat' } });
    });
    const r = await session(s.port, '/stop\n', ['-c']);
    expect(r.out).toContain('The Zotero window shows another chat; nothing was stopped.');
    expect(r.err).toBe('');
  });

  it('/stop says the run had already finished when it completed instead of being canceled', async () => {
    const s = await start(withSavedChat(), (h) => {
      h.stop = () => ({ json: { ok: true, stopped: true, run_id: R } });
      h.status = () => ({ json: { ok: true, run_id: R, thread_id: T, state: 'completed', is_active: false } });
    });
    const r = await session(s.port, '/stop\n', ['-c']);
    expect(r.out).toContain('The run had already finished.');
    expect(r.out).not.toContain('Stopped.');
  });

  it('/resume <id> binds a saved chat and prints its last exchange; an unknown id prints Next and continues', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, `/resume ${T}\n/help\n`);
    expect(r.out).toContain('> **User:** Reply with the single word OK.');
    expect(s.routes().indexOf('open')).toBeLessThan(s.routes().indexOf('thread'));
    await fake!.close();
    const s2 = await start(withSavedChat({ open: refusal('thread_not_found', 404, 'No chat with this id') }));
    const bad = await session(s2.port, `/resume ${ZERO}\n/help\n`);
    expect(bad.err).toContain('Next: ');
    expect(bad.out).toContain('/quit');
  });

  it('/resume with a value that is not a chat id says so without a request', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '/resume abc\n');
    expect(r.err).toContain("beaver: 'abc' is not a chat id.");
    expect(s.count('open')).toBe(0);
  });

  it('a window in use refuses /resume with its code and the session goes on', async () => {
    const s = await start(withSavedChat({ open: refusal('busy_draft', 409, 'A message is being written in the window') }));
    const r = await session(s.port, `/resume ${T}\n/help\n`);
    expect(r.err).toContain('beaver: A message is being written in the window');
    expect(r.out).toContain('/quit');
  });
});

describe('interactive: start', () => {
  it('-c prints the title and the last exchange of the most recent chat, not the earlier ones', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '', ['-c']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Chat: Example chat about algorithmic fairness');
    expect(r.out).toContain('> **User:** Reply with the single word OK.\n\nOK');
    expect(r.out).not.toContain('In one sentence');
    expect(s.routes()).toEqual(['info', 'threads', 'open', 'thread']);
  });

  it('-c with no saved chat says that the next message starts a new chat', async () => {
    const s = await start({ threads: [], runs: [answeredRun([''])] });
    const r = await session(s.port, 'hello\n', ['-c']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No saved chat yet; the next message starts a new chat.');
    expect(s.bodyOf('send').thread_id).toBe('new');
  });

  it('a closed port at start exits 10', async () => {
    const f = await startFakeBeaver({});
    const port = f.port;
    await f.close();
    const r = await session(port, '');
    expect(r.code).toBe(10);
    expect(r.out).toBe('');
    expect(r.err).toContain('Next: ');
  });

  it("a 404 at start exits 11 with the step to switch on 'Terminal and script access'", async () => {
    fake = await startFakeBeaver({});
    const r = await session(fake.port, '');
    expect(r.code).toBe(11);
    expect(r.err).toContain('Terminal and script access');
  });

  for (const [what, info, code] of [
    ['no_window', { ok: true, interface_version: 1, plugin_version: 'x', windows: [], default_window_id: null }, 12],
    ['account_changed', refusal('account_changed', 409), 20],
    ['protocol', refusal('internal', 500), 21],
  ] as const) {
    it(`an info that fails with ${what} exits ${code} before any prompt`, async () => {
      const s = await start({ info });
      const r = await session(s.port, 'hello\n');
      expect(r.code).toBe(code);
      expect(r.out).toBe('');
      expect(r.err).toContain('Next: ');
      expect(s.count('send')).toBe(0);
    });
  }

  it('-r with an unknown id exits 14 before any prompt', async () => {
    const s = await start(withSavedChat({ open: refusal('thread_not_found', 404, 'No chat with this id') }));
    const r = await session(s.port, 'hello\n', ['-r', ZERO]);
    expect(r.code).toBe(14);
    expect(r.out).toBe('');
    expect(s.count('send')).toBe(0);
  });

  it('-r <id> opens the chat before reading its transcript', async () => {
    const s = await start(withSavedChat());
    const r = await session(s.port, '', ['-r', T]);
    expect(r.code).toBe(0);
    expect(s.bodyOf('open')).toMatchObject({ thread_id: T });
    expect(s.routes().indexOf('open')).toBeLessThan(s.routes().indexOf('thread'));
    expect(r.out).toContain('> **User:** Reply with the single word OK.');
  });

  it('--item without -p is a usage error', async () => {
    const r = await session(1, '', ['--item', 'ABCD1234']);
    expect(r.code).toBe(2);
  });
});

describe('interactive: Ctrl-C', () => {
  function interrupts() {
    let handler: (() => void) | undefined;
    return {
      onInterrupt: (h: () => void) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      },
      fire: () => handler?.(),
      subscribed: () => handler !== undefined,
    };
  }

  it('an interrupt during a run stops it, prints [stopped], and the next message is sent and answered', async () => {
    const ic = interrupts();
    const s = await start({
      runs: [{ frames: [{ state: 'running', text: 'Partial' }, () => (ic.fire(), { state: 'running', text: 'Partial' })] }, answeredRun([''])],
    });
    const r = await session(s.port, 'one\ntwo\n', [], { onInterrupt: ic.onInterrupt });
    expect(r.code).toBe(0);
    expect(s.count('stop')).toBe(1);
    expect(r.out).toContain('[stopped]');
    expect(s.count('send')).toBe(2);
    expect(s.bodyOf('send', 1)).toMatchObject({ text: 'two', thread_id: NEW_T });
    expect(r.out).toContain('Holm’s (2023)'); // answer of the second message
  });

  it('an interrupt while a y/n question is open stops the run without answering the card', async () => {
    const ic = interrupts();
    const s = await start({ runs: [{ frames: [approvalFrame('act1')] }, answeredRun([''])] });
    const stdin = new PassThrough();
    const cap = capture({ stdin, onInterrupt: ic.onInterrupt });
    const done = runCli(['--port', String(s.port)], cap.io, { pollMs: 5 });
    stdin.write('edit my note\n');
    await waitFor(() => cap.stdout().includes('Approve? '));
    ic.fire();
    await waitFor(() => cap.stdout().includes('[stopped]'));
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(1);
    stdin.write('two\n'); // not taken as the answer to the abandoned question
    stdin.end();
    expect(await done).toBe(0);
    expect(s.count('send')).toBe(2);
    expect(s.bodyOf('send', 1).text).toBe('two');
  });

  it('an approval answered in the Zotero window releases the open question: the answer is printed and the next line is a new message', async () => {
    const s = await start({
      runs: [
        answeredRun([''], { frames: [approvalFrame('act1'), approvalFrame('act1'), approvalFrame('act1'), { state: 'running' }, { state: 'completed' }] }),
        answeredRun(['']),
      ],
    });
    const stdin = new PassThrough();
    const cap = capture({ stdin });
    const done = runCli(['--port', String(s.port)], cap.io, { pollMs: 5 });
    stdin.write('edit my note\n');
    await waitFor(() => cap.stdout().includes('Answered in the Zotero window.'));
    expect(cap.stdout()).toContain('Approve? ');
    stdin.write('two\n'); // a new message, not the answer to the released question
    stdin.end();
    expect(await done).toBe(0);
    expect(s.count('approve')).toBe(0);
    expect(s.count('send')).toBe(2);
    expect(s.bodyOf('send', 1)).toMatchObject({ text: 'two', thread_id: NEW_T });
    expect(cap.stdout().match(/Holm’s \(2023\)/g)?.length).toBeGreaterThanOrEqual(2); // both answers printed
  });

  it('a deadline while a y/n question is open leaves no stale waiter: the next line is a new message', async () => {
    const s = await start({ runs: [{ frames: [approvalFrame('act1')] }, answeredRun([''])] });
    const stdin = new PassThrough();
    const cap = capture({ stdin });
    const done = runCli(['--port', String(s.port), '--timeout', '0.3'], cap.io, { pollMs: 5 });
    stdin.write('edit my note\n');
    await waitFor(() => cap.stdout().includes('Approve? '));
    await waitFor(() => cap.stderr().includes('No answer within'));
    stdin.write('two\n');
    stdin.end();
    expect(await done).toBe(0);
    expect(s.count('approve')).toBe(0);
    expect(s.count('stop')).toBe(1);
    expect(s.count('send')).toBe(2);
    expect(s.bodyOf('send', 1).text).toBe('two');
    expect(cap.stdout()).not.toContain('Answered in the Zotero window.');
  });

  it('end of input while a y/n question is open declines the change; the run finishes and the session exits 0', async () => {
    const s = await start({ runs: [answeredRun([''], { frames: [approvalFrame('act1')], afterAnswer: [{ state: 'running' }, { state: 'completed' }] })] });
    const r = await session(s.port, 'edit my note\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Approve? ');
    expect(s.bodyOf('approve')).toMatchObject({ action_id: 'act1', approved: false });
    expect(s.bodyOf('approve').instructions).toBeUndefined();
    expect(s.count('stop')).toBe(0);
    expect(r.out).toContain('Holm’s (2023)');
  });

  it('end of input at a credit confirmation declines it; the run is stopped and the session exits 0', async () => {
    const c = { confirmation_id: 'cc1', title: 'Large run', message: 'This uses 40 credits', pending_credits: 40 };
    const s = await start({ runs: [{ frames: [{ state: 'awaiting_input', credit_confirmations: [c] }], afterAnswer: [{ state: 'running' }] }] });
    const r = await session(s.port, 'big question\n');
    expect(r.code).toBe(0);
    expect(s.bodyOf('approve')).toMatchObject({ kind: 'credits', confirmation_id: 'cc1', approved: false });
    expect(s.count('stop')).toBe(1);
  });

  it('a second interrupt while the stop is in progress leaves at once with exit 18', async () => {
    const ic = interrupts();
    const s = await start({ runs: [{ frames: [() => (ic.fire(), { state: 'running', text: 'x' })] }] }, (h) => {
      h.stop = () => ({ hang: true }); // the stop never returns
    });
    const exits: number[] = [];
    const stdin = new PassThrough(); // stays open
    const cap = capture({ stdin, onInterrupt: ic.onInterrupt, exit: (c) => exits.push(c) });
    const done = runCli(['--port', String(s.port)], cap.io, { pollMs: 5 });
    stdin.write('one\n');
    await waitFor(() => s.count('stop') === 1);
    ic.fire();
    expect(await done).toBe(18);
    expect(exits).toEqual([18]);
    expect(cap.stderr()).toContain('left without waiting for the stop');
  });

  it('an interrupt at the prompt leaves with exit 0', async () => {
    const ic = interrupts();
    const s = await start(answerFirstChat());
    const stdin = new PassThrough(); // stays open
    const cap = capture({ stdin, onInterrupt: ic.onInterrupt });
    const done = runCli(['--port', String(s.port)], cap.io, { pollMs: 5 });
    await waitFor(() => cap.stdout().includes('> ') && ic.subscribed());
    ic.fire();
    expect(await done).toBe(0);
    expect(ic.subscribed()).toBe(false);
  });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

