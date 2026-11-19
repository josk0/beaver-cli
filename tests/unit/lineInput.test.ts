import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { PASTE_MS, TerminalInput } from '../../src/modes/lineInput.js';
import { chatSim, startFakeBeaver, type FakeBeaver } from '../helpers/fakeBeaver.js';
import { answeredRun, approvalFrame, endlessRun } from '../helpers/cli.js';

/** A keyboard: a stream that says it is a terminal and accepts raw mode. */
function keyboard(): PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => unknown } {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
}

function screen() {
  let out = '';
  return { write: (s: string) => (out += s), isTTY: true, columns: 80, text: () => out, clear: () => (out = '') };
}

const wait = (ms = PASTE_MS + 20) => new Promise((r) => setTimeout(r, ms));
const KEY = { left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', up: '\x1b[A', backspace: '\x7f', ctrlC: '\x03', ctrlD: '\x04' };

// Node's readline turns line editing off when TERM is 'dumb' (as on CI runners).
process.env.TERM = 'xterm-256color';

let input: TerminalInput | undefined;
afterEach(() => {
  input?.close();
  input = undefined;
});

describe('TerminalInput (a fake terminal: keys in, bytes out)', () => {
  it('edits the line: left, home, end, backspace', async () => {
    const kb = keyboard();
    input = new TerminalInput(kb, screen());
    const p = input.read({ prompt: '› ', history: true });
    // One key per chunk, as a keyboard sends them: Node 20 does not split a chunk that mixes keys.
    for (const key of ['helo', KEY.left, 'l', KEY.home, 'X', KEY.end, '!', KEY.backspace, '?', '\r']) {
      kb.write(key);
      await wait(2);
    }
    expect(await p).toBe('Xhello?');
  });

  it('draws the prompt itself; keys typed while no read waits are not echoed, and appear with the next prompt', async () => {
    const kb = keyboard();
    const sc = screen();
    input = new TerminalInput(kb, sc);
    kb.write('ty');
    await wait();
    expect(sc.text()).toBe('');
    const p = input.read({ prompt: '› ' });
    expect(sc.text()).toContain('› ty');
    kb.write('ped\r');
    expect(await p).toBe('typed');
  });

  it('up recalls this session\'s messages and commands, not answers', async () => {
    const kb = keyboard();
    input = new TerminalInput(kb, screen());
    let p = input.read({ prompt: '› ', history: true });
    kb.write('first message\r');
    expect(await p).toBe('first message');
    p = input.read({ prompt: 'Approve? ' });
    kb.write('y\r');
    expect(await p).toBe('y');
    p = input.read({ prompt: '› ', history: true });
    kb.write(`${KEY.up}\r`);
    expect(await p).toBe('first message');
  });

  it('lines that arrive together (a paste) are one message; lines typed apart are not', async () => {
    const kb = keyboard();
    input = new TerminalInput(kb, screen());
    const p = input.read({ prompt: '› ', history: true });
    kb.write('line one\rline two\rline three\r');
    expect(await p).toBe('line one\nline two\nline three');
    const q = input.read({ prompt: '› ' });
    kb.write('a\r');
    await wait();
    kb.write('b\r');
    expect(await q).toBe('a');
    expect(await input.read({ prompt: '› ' })).toBe('b');
  });

  it('Ctrl-C reports the line typed so far; Ctrl-D on an empty line ends the input; an abort releases a read', async () => {
    const kb = keyboard();
    input = new TerminalInput(kb, screen());
    const seen: string[] = [];
    input.onInterrupt = (line) => seen.push(line);
    const ac = new AbortController();
    const p = input.read({ prompt: '› ', signal: ac.signal });
    kb.write(`abc${KEY.ctrlC}`);
    await wait();
    expect(seen).toEqual(['abc']);
    ac.abort();
    expect(await p).toBeNull();
    const q = input.read({ prompt: '› ' });
    kb.write(KEY.ctrlD);
    expect(await q).toBeNull();
  });
});

describe('interactive mode on a terminal at both ends', () => {
  let fake: FakeBeaver | undefined;
  let lastScreen = () => '';
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function start(runs = [answeredRun(['']), answeredRun([''])]) {
    fake = await startFakeBeaver(chatSim({ runs }).handlers);
    const kb = keyboard();
    const sc = screen();
    lastScreen = () => JSON.stringify(sc.text());
    const done = runCli(['--port', String(fake.port)], { stdin: kb, stdout: sc, stderr: { write: () => true }, env: { NO_COLOR: '1' } }, { pollMs: 5 });
    return { kb, sc, done, sends: () => fake!.calls.filter((c) => c.route === 'send').map((c) => c.body.text) };
  }

  /** The prompt is back after an answer: drawn after its source list. */
  const promptAfterAnswer = (text: string) => text.includes('Sources') && text.lastIndexOf('› ') > text.lastIndexOf('Sources');

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await wait(10);
    expect(cond(), lastScreen()).toBe(true);
  };

  it('a message is sent and answered, the prompt comes back, and Ctrl-D leaves', async () => {
    const t = await start();
    await until(() => t.sc.text().includes('› '));
    t.kb.write('what is in my library?\r');
    await until(() => t.sc.text().includes('Sources'));
    await until(() => promptAfterAnswer(t.sc.text()));
    t.kb.write(KEY.ctrlD);
    expect(await t.done).toBe(0);
    expect(t.sends()).toEqual(['what is in my library?']);
  });

  it('Ctrl-C at a prompt with text clears the line; at an empty prompt it leaves', async () => {
    const t = await start();
    await until(() => t.sc.text().includes('› '));
    t.kb.write(`not this${KEY.ctrlC}`);
    await wait();
    t.kb.write('this\r');
    await until(() => t.sends().length === 1);
    expect(t.sends()).toEqual(['this']);
    await until(() => promptAfterAnswer(t.sc.text()));
    t.kb.write(KEY.ctrlC);
    expect(await t.done).toBe(0);
  });

  it('Ctrl-C during an answer stops the run; an approval is answered at its own prompt and stays out of the history', async () => {
    const t = await start([
      answeredRun([''], { frames: [approvalFrame('act1')], afterAnswer: [{ state: 'completed' }] }),
      endlessRun('Working on it'),
      answeredRun(['']),
    ]);
    await until(() => t.sc.text().includes('› '));
    t.kb.write('edit my note\r');
    await until(() => t.sc.text().includes('Approve? '));
    t.kb.write('y\r');
    await until(() => promptAfterAnswer(t.sc.text()));
    t.kb.write('keep going\r');
    await until(() => t.sc.text().includes('Working'));
    t.kb.write(KEY.ctrlC);
    await until(() => t.sc.text().includes('[stopped]'));
    expect(fake!.calls.filter((c) => c.route === 'stop')).toHaveLength(1);
    await wait();
    t.kb.write(`${KEY.up}${KEY.up}\r`);
    await until(() => t.sends().length === 3);
    expect(t.sends()).toEqual(['edit my note', 'keep going', 'edit my note']);
    t.kb.write(KEY.ctrlD);
    await t.done;
  });

  it('a backslash at the end of a line continues the message on the next line', async () => {
    const t = await start();
    await until(() => t.sc.text().includes('› '));
    t.kb.write('first \\\r');
    await wait();
    t.kb.write('second\r');
    await until(() => t.sends().length === 1);
    expect(t.sends()).toEqual(['first \nsecond']);
    t.kb.write(KEY.ctrlD);
    await t.done;
  });
});
