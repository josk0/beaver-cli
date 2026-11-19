import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { ThreadView } from '../../src/client/types.js';
import { DisplayNames } from '../../src/core/displayNames.js';
import { AnswerStream } from '../../src/modes/stream.js';
import { chatSim, fixture, NEW_T, refusal, startFakeBeaver, type FakeBeaver, type FakeHandler, type Frame, type SimRun } from '../helpers/fakeBeaver.js';
import { answeredRun, capture, HOLM, holmThread, questionOf } from '../helpers/cli.js';

let fake: FakeBeaver | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

interface Step {
  text: string;
  tools?: string[];
  /** Beaver's labels of the tools, by position; none when unset. */
  labels?: string[];
}

const frame = (s: Step): Frame => ({
  state: 'running',
  text: s.text,
  tool_calls: (s.tools ?? []).map((name, i) => ({ id: `call_${name}_${i}`, name, label: s.labels?.[i] ?? null, returned: false })),
});

interface Options {
  /** The run's text when it completed; default the last step's. */
  finalText?: string;
  /** `thread` of the run; default the Holm fixture, which also names the source of HOLM. */
  thread?: unknown;
  /** Frames between the steps and the completion. */
  extra?: Frame[];
  run?: Partial<SimRun>;
}

/** A Beaver whose first run shows `steps` in successive polls, then completes; a second message gets a plain answer. */
function streamWindow(steps: Step[], o: Options = {}): Record<string, FakeHandler> {
  const last = steps[steps.length - 1];
  const final = o.finalText ?? last?.text ?? '';
  const run: SimRun = {
    frames: [...steps.map(frame), ...(o.extra ?? []), { ...(frame(last ?? { text: '' }) as object), state: 'completed', text: final }],
    thread: o.thread ?? holmThread,
    ...o.run,
  };
  return chatSim({ runs: [run, answeredRun()] }).handlers;
}

async function run(handlers: Record<string, FakeHandler>, input = 'q\n') {
  fake = await startFakeBeaver(handlers);
  const f = fake;
  const cap = capture({ stdinText: input });
  const code = await runCli(['--port', String(f.port)], cap.io, { pollMs: 5 });
  return { code, out: cap.stdout(), err: cap.stderr(), calls: (route: string) => f.calls.filter((c) => c.route === route).map((c) => c.body) };
}

const count = (s: string, part: string) => s.split(part).length - 1;

describe('interactive streaming', () => {
  it('prints text that arrives in three steps once each, in order', async () => {
    const r = await run(streamWindow([{ text: 'Alpha beta.' }, { text: 'Alpha beta. Gamma delta.' }, { text: 'Alpha beta. Gamma delta. Epsilon.' }]));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Alpha beta. Gamma delta. Epsilon.');
    for (const w of ['Alpha', 'Gamma', 'Epsilon']) expect(count(r.out, w)).toBe(1);
  });

  it("prints a citation split across two polls as the display name, once, never as a raw tag; the name comes from the run's citations", async () => {
    const r = await run(
      streamWindow([
        { text: 'It examines fairness. <citat' },
        { text: `It examines fairness. <citation id="${HOLM}"/> More.` },
      ]),
    );
    expect(r.out).toContain('It examines fairness. (Holm 2023) More.');
    expect(r.out).not.toContain('<c');
    expect(r.out).not.toContain('citation');
    expect(count(r.out, 'Holm 2023')).toBe(1);
    const reads = r.calls('thread');
    expect(reads[0]).toMatchObject({ thread_id: NEW_T, run_id: reads[0].run_id });
    // One read for the name while streaming, one for the final answer.
    expect(reads).toHaveLength(2);
  });

  it("a citation in a sentence before the run's last tool call gets its name from the whole chat", async () => {
    const noCitations = (b: any) => ({ ...holmThread(b), citations: { by_key: {}, page_labels_by_attachment_id: {} } });
    const steps = [{ text: `Found <citation id="${HOLM}"/>.` }, { text: `Found <citation id="${HOLM}"/>.`, tools: ['view'] }];
    const sim: SimRun = { frames: [...steps.map(frame), { state: 'completed', text: steps[1].text }], thread: noCitations };
    const r = await run(chatSim({ runs: [sim], thread: (b: any) => holmThread(b) }).handlers);
    expect(r.out).toContain('Found (Holm 2023).');
    expect(r.calls('thread').map((b) => 'run_id' in b)).toEqual([true, false, true]);
  });

  it('holds back a bare "<" and a half-written tag, and prints a "<" that is not a tag', async () => {
    const r = await run(streamWindow([{ text: 'a <' }, { text: 'a < b and <citation id="' }, { text: `a < b and <citation id="${HOLM}"/>.` }]));
    expect(r.out).toContain('a < b and (Holm 2023).');
    expect(r.out).not.toContain('<citation');
  });

  it("a citation the run's citations do not name prints nothing for the tag", async () => {
    const r = await run(streamWindow([{ text: 'Fairness <citation id="u-ZZZZZZZZ"/> matters.' }]));
    expect(r.out).toContain('Fairness matters.');
    expect(r.out).not.toContain('()');
    expect(r.out).not.toContain('citation');
  });

  it('a failing read of the citations does not break streaming', async () => {
    let reads = 0;
    const r = await run(
      streamWindow([{ text: `Before <citation id="${HOLM}"/> after.` }, { text: `Before <citation id="${HOLM}"/> after. More.` }], {
        thread: (b: any) => (++reads <= 2 ? refusal('internal', 500) : holmThread(b)),
      }),
    );
    expect(r.code).toBe(0);
    // The citation waits for its name and appears once a read succeeds.
    expect(r.out).toContain('Before (Holm 2023) after. More.');
  });

  it('a tool call between two text steps puts its line on its own line, and the text continues on a fresh line', async () => {
    const r = await run(
      streamWindow([{ text: 'Looking.' }, { text: 'Looking.', tools: ['item_search_by_topic'] }, { text: 'Looking.\nFound it.', tools: ['item_search_by_topic'] }]),
    );
    expect(r.out).toContain('Looking.\n· item_search_by_topic\nFound it.');
    expect(count(r.out, '· item_search_by_topic')).toBe(1);
  });

  it('prints a tail of the final text that no poll showed, and not the answer twice; Sources follow', async () => {
    const r = await run(streamWindow([{ text: 'Head of the answer.' }], { finalText: 'Head of the answer. Tail seen only at the end.' }));
    expect(r.out).toContain('Head of the answer. Tail seen only at the end.\n\nSources:\n[1] ');
    expect(count(r.out, 'Head of the answer.')).toBe(1);
    // The answer read from the chat is not printed again.
    expect(r.out).not.toContain('Holm’s (2023) “The Fairness');
    expect(r.err).toContain(`Chat: ${NEW_T}`);
  });

  it('prints the answer read from the chat when the text could not be streamed (text that stopped being a continuation)', async () => {
    const r = await run(streamWindow([{ text: 'First version of the text.' }, { text: 'Something else.' }]));
    expect(r.out).toContain('First version of the text.');
    expect(r.out).toContain('Holm’s (2023)');
    expect(r.out).toContain('Sources:\n[1] ');
    expect(count(r.out, 'Something else.')).toBe(0); // never streamed after the break
  });

  it('prints the answer read from the chat when the run showed no text at all', async () => {
    const r = await run(streamWindow([{ text: '' }]));
    expect(r.out).toContain('Holm’s (2023)');
    expect(r.out).toContain('Sources:\n[1] ');
  });

  it('a stopped run keeps the streamed part, prints it once, and then says [stopped]', async () => {
    let fire: (() => void) | undefined;
    const h = chatSim({ runs: [{ frames: [frame({ text: 'Streamed part of the answer, ' })] }] }).handlers;
    const status = h.status;
    let polls = 0;
    h.status = (b, i) => {
      if (++polls === 3) fire?.();
      return status(b, i);
    };
    fake = await startFakeBeaver(h);
    const cap = capture({
      stdinText: 'q\n',
      onInterrupt: (handler) => {
        fire = handler;
        return () => {};
      },
    });
    const code = await runCli(['--port', String(fake.port)], cap.io, { pollMs: 5 });
    expect(code).toBe(0);
    expect(count(cap.stdout(), 'Streamed part of the answer,')).toBe(1);
    expect(cap.stdout()).toContain('[stopped]');
    expect(cap.stdout().indexOf('[stopped]')).toBeGreaterThan(cap.stdout().indexOf('Streamed part'));
  });

  it('a question never starts in the middle of a line of the answer', async () => {
    const r = await run(
      streamWindow([{ text: 'Thinking out loud' }], {
        extra: [{ state: 'awaiting_input', questions: [questionOf('tq')] }],
        run: { afterAnswer: [{ state: 'completed', text: 'Thinking out loud' }] },
      }),
    );
    expect(r.out).toContain('Thinking out loud\nBeaver has a question');
  });

  it('script mode does not stream: it prints the answer read from the chat once', async () => {
    fake = await startFakeBeaver(streamWindow([{ text: 'Head of the answer.' }]));
    const cap = capture();
    const code = await runCli(['-p', 'q', '--port', String(fake.port)], cap.io, { pollMs: 5 });
    expect(code).toBe(0);
    expect(cap.stdout()).toContain('Holm’s (2023)');
    expect(cap.stdout()).not.toContain('Head of the answer.');
  });
});

describe('AnswerStream', () => {
  const make = () => {
    let out = '';
    const s = new AnswerStream((t) => (out += t), async (id) => (id === HOLM ? 'Holm 2023' : null));
    return { s, out: () => out };
  };

  it('appends only the new part and holds trailing whitespace until more text follows', async () => {
    const { s, out } = make();
    s.text('One two ');
    await s.settle();
    expect(out()).toBe('One two\n');
    const b = make();
    b.s.text('One two ');
    b.s.text('One two three');
    await b.s.settle();
    expect(b.out()).toBe('One two three\n');
  });

  it('shrinking text stops the streaming', async () => {
    const { s, out } = make();
    s.text('One two three');
    s.text('One two');
    s.text('One two three four');
    await s.settle();
    expect(s.abandoned).toBe(true);
    expect(out()).toBe('One two three\n');
  });

  it('a finished run drops a cut-off tag and keeps a lone "<"', async () => {
    const a = make();
    a.s.text('End <citation id="u-PVX');
    await a.s.finish();
    expect(a.out()).toBe('End\n');
    const b = make();
    b.s.text('x <');
    await b.s.finish();
    expect(b.out()).toBe('x <\n');
  });
});

describe('DisplayNames', () => {
  const view = fixture('thread-run-a') as ThreadView;
  const empty = { ...view, citations: { by_key: {}, page_labels_by_attachment_id: {} } } as ThreadView;

  it("one read of the run's citations serves every name; a name found is kept", async () => {
    const reads: string[] = [];
    const names = new DisplayNames(async (scope) => {
      reads.push(scope);
      return view;
    });
    expect(await names.name(HOLM)).toBe('Holm 2023');
    expect(await names.name(HOLM)).toBe('Holm 2023');
    expect(reads).toEqual(['run']);
  });

  it("a name the run's answer does not cite (an earlier sentence of the run) is read from the whole chat", async () => {
    const reads: string[] = [];
    const names = new DisplayNames(async (scope) => {
      reads.push(scope);
      return scope === 'run' ? empty : view;
    });
    expect(await names.name(HOLM)).toBe('Holm 2023');
    expect(reads).toEqual(['run', 'chat']);
    expect(await names.name('u-NONE0000')).toBeNull();
  });

  it('an id no read can name is not read again during the run; a new run tries again; a failed read proves nothing', async () => {
    let reads = 0;
    const names = new DisplayNames(async () => {
      reads++;
      return empty;
    });
    expect(await names.name('u-MASKED00')).toBeNull();
    expect(await names.name('u-MASKED00')).toBeNull();
    expect(reads).toBe(2); // run and chat, once
    names.newRun();
    await names.name('u-MASKED00');
    expect(reads).toBe(4);
    let fails = 0;
    const flaky = new DisplayNames(async () => {
      fails++;
      throw new Error('x');
    });
    await flaky.name(HOLM);
    await flaky.name(HOLM);
    expect(fails).toBe(4);
    expect(names.known('u-MASKED00')).toBeNull();
  });

  it('a slow or failing read gives null instead of holding the text; no run yet gives null', async () => {
    expect(await new DisplayNames(() => new Promise(() => {}), 50).name(HOLM)).toBeNull();
    expect(await new DisplayNames(async () => Promise.reject(new Error('x'))).name(HOLM)).toBeNull();
    expect(await new DisplayNames(async () => null).name(HOLM)).toBeNull();
  });
});

describe('AnswerStream: repeated citations', () => {
  const run = async (raws: string[]): Promise<string> => {
    let out = '';
    const s = new AnswerStream((x) => (out += x), async (id) => (id.endsWith('AAAA1111') ? 'Holm 2023' : 'Krakovsky 2022'));
    for (const r of raws) s.text(r);
    await s.finish();
    return out;
  };

  it('shows two adjacent tags of the same source once', async () => {
    const out = await run(['A claim. <citation id="u-AAAA1111"/><citation id="u-AAAA1111" loc="s1.2"/> Next.']);
    expect(out).toBe('A claim. (Holm 2023) Next.\n');
  });

  it('also when the second tag arrives in a later poll', async () => {
    const a = 'A claim. <citation id="u-AAAA1111"/>';
    const out = await run([a, `${a} <citation id="u-AAAA1111"/> Next.`]);
    expect(out).toBe('A claim. (Holm 2023) Next.\n');
  });

  it('keeps tags of different sources; the same source again shows only after another source', async () => {
    const out = await run(['X <citation id="u-AAAA1111"/><citation id="u-BBBB2222"/> Y <citation id="u-BBBB2222"/>. Z <citation id="u-AAAA1111"/>']);
    expect(out).toBe('X (Holm 2023; Krakovsky 2022) Y. Z (Holm 2023)\n');
  });

  it('a citation is held until the next non-blank text shows whether another one joins its bracket', async () => {
    let out = '';
    const s = new AnswerStream((x) => (out += x), async (id) => (id.endsWith('AAAA1111') ? 'Green 2022' : 'Wong 2020'));
    s.text('A claim <citation id="u-AAAA1111"/>');
    await s.settle();
    expect(out).toBe('A claim\n');
    out = '';
    const t = new AnswerStream((x) => (out += x), async (id) => (id.endsWith('AAAA1111') ? 'Green 2022' : 'Wong 2020'));
    for (const r of ['A claim <citation id="u-AAAA1111"/>', 'A claim <citation id="u-AAAA1111"/> <citation id="u-BBBB2222"/>', 'A claim <citation id="u-AAAA1111"/> <citation id="u-BBBB2222"/>. Next']) t.text(r);
    await t.finish();
    expect(out).toBe('A claim (Green 2022; Wong 2020). Next\n');
  });

  it('a citation at the end of the run is shown when the run finishes', async () => {
    expect(await run(['The end <citation id="u-AAAA1111"/>'])).toBe('The end (Holm 2023)\n');
  });

  it('tags inside code spans and code blocks stay as written; a tag after a code span still open waits for it', async () => {
    expect(await run(['Use `<citation id="u-AAAA1111"/>` like this <citation id="u-AAAA1111"/>.'])).toBe(
      'Use `<citation id="u-AAAA1111"/>` like this (Holm 2023).\n',
    );
    expect(await run(['```\n<citation id="u-AAAA1111"/>\n```\nOk.'])).toBe('```\n<citation id="u-AAAA1111"/>\n```\nOk.\n');
    let out = '';
    const s = new AnswerStream((x) => (out += x), async () => 'Holm 2023');
    s.text('Write `<citation id="u-AAAA1111"/>');
    await new Promise((r) => setTimeout(r, 10));
    expect(out).toBe('Write `');
    s.text('Write `<citation id="u-AAAA1111"/>` to cite.');
    await s.finish();
    expect(out).toContain('`<citation id="u-AAAA1111"/>` to cite.');
  });
});

describe('interactive mode on a terminal', () => {
  /** Like `run`, with stdout a terminal of 60 columns. */
  async function runTTY(handlers: Record<string, FakeHandler>, env: Record<string, string> = {}) {
    fake = await startFakeBeaver(handlers);
    const cap = capture({ stdinText: 'q\n', env });
    let out = '';
    cap.io.stdout = { write: (s: string) => (out += s), isTTY: true, columns: 60 };
    const code = await runCli(['--port', String(fake.port)], cap.io, { pollMs: 5 });
    return { code, out, err: cap.stderr() };
  }

  const steps = [
    { text: '' },
    { text: '', tools: ['item_search_by_topic'] },
    { text: `**Fairness** matters <citation id="${HOLM}"/>. More text follows.`, tools: ['item_search_by_topic'] },
  ];

  it('styles the prompt, tool lines, the answer and the sources, with a spinner cleared first', async () => {
    const r = await runTTY(streamWindow(steps));
    expect(r.code).toBe(0);
    expect(r.out.startsWith('\x1b[1;36m›\x1b[0m \n\n\r  \x1b[2m⠋ Thinking…')).toBe(true);
    expect(r.out).toContain('\r\x1b[2K  \x1b[2m· Searching the library by topic\x1b[0m\n\n');
    expect(r.out).toContain('  \x1b[1mFairness\x1b[0m matters \x1b[2m(Holm 2023)\x1b[0m. More text follows.\n\n  \x1b[1mSources\x1b[0m\n    \x1b[2m[1] ');
    expect(r.out).not.toContain('**');
    expect(r.out.lastIndexOf('Thinking')).toBeLessThan(r.out.indexOf('Searching'));
  });

  it("shows Beaver's own tool label when status gives one", async () => {
    const r = await runTTY(streamWindow([{ text: 'x', tools: ['item_search'], labels: ['Item search: "fairness"'] }]), { NO_COLOR: '1' });
    expect(r.out).toContain('  · Item search: "fairness"\n');
  });

  it('with NO_COLOR: the same layout and no escape code', async () => {
    const r = await runTTY(streamWindow(steps), { NO_COLOR: '1' });
    expect(r.out).not.toContain('\x1b');
    expect(r.out).toContain('› ');
    expect(r.out).toContain('  · Searching the library by topic\n\n  Fairness matters (Holm 2023). More text follows.\n\n  Sources\n    [1] ');
  });

  it('an answer that was not streamed goes through the same renderer', async () => {
    const r = await runTTY(streamWindow([{ text: '' }]), { NO_COLOR: '1' });
    expect(r.out).toContain('  Holm’s (2023)');
    expect(r.out).toContain('\n\n  Sources\n    [1] ');
    const t = await runTTY(streamWindow([{ text: '', tools: ['item_search_by_topic'] }]), { NO_COLOR: '1' });
    expect(t.out).toContain('· Searching the library by topic\n\n  Holm’s (2023)');
  });

  it('the spinner is cleared before a question is shown', async () => {
    const r = await runTTY(
      streamWindow([{ text: '' }], {
        extra: [{ state: 'awaiting_input', questions: [questionOf('tq')] }],
        run: { afterAnswer: [{ state: 'completed', text: '' }] },
      }),
    );
    const q = r.out.indexOf('Beaver has a question');
    expect(q).toBeGreaterThan(0);
    expect(r.out.lastIndexOf('Thinking…', q)).toBeLessThan(r.out.lastIndexOf('\r\x1b[2K', q));
    expect(r.out.lastIndexOf('\r\x1b[2K', q)).toBeGreaterThan(0);
  });

  it('when stdout is not a terminal nothing is styled', async () => {
    const r = await run(streamWindow(steps));
    expect(r.out).toContain('> ');
    expect(r.out).toContain('· item_search_by_topic\n**Fairness** matters (Holm 2023).');
    expect(r.out).not.toContain('›');
    expect(r.out).not.toContain('Thinking');
    expect(r.out).not.toContain('\x1b');
  });
});

describe('AnswerStream: a citation whose name arrives late', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A names source that knows a name only from the `from`-th lookup of that id on (1-based). */
  function lateNames(known: Record<string, { name: string; from: number }>) {
    const asked = new Map<string, number>();
    return async (id: string) => {
      const n = (asked.get(id) ?? 0) + 1;
      asked.set(id, n);
      const k = known[id];
      return k && n >= k.from ? k.name : null;
    };
  }

  const styles = [
    { label: 'plain', style: undefined },
    { label: 'styled', style: { color: false, width: 80 } },
  ];

  for (const { label, style } of styles) {
    it(`${label}: unknown on the first two polls, known on the third, the citation appears in place, nothing lost or doubled`, async () => {
      let out = '';
      const s = new AnswerStream((x) => (out += x), lateNames({ 'u-W': { name: 'Wong 2020', from: 3 } }), (x) => x, style);
      const head = 'First claim <citation id="u-W"/>. Second';
      s.text(head);
      await s.settle().catch(() => {});
      expect(out).not.toContain('Second');
      s.text(`${head} sentence`);
      s.text(`${head} sentence ends here.`);
      await s.finish();
      const flat = out.replace(/\n\s*/g, ' ').trim();
      expect(flat).toContain('First claim (Wong 2020). Second sentence ends here.');
      expect(out.split('First claim').length).toBe(2);
    });
  }

  it('never known: dropped after 6 s, and the text after it appears', async () => {
    vi.useFakeTimers();
    let out = '';
    const s = new AnswerStream((x) => (out += x), async () => null);
    s.text('A claim <citation id="u-X"/>. More text here');
    await vi.advanceTimersByTimeAsync(10);
    expect(out).toBe('A claim');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out).toBe('A claim');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(out).toBe('A claim. More text here');
  });

  it('unknown until the run ends, known in the final lookup: shown', async () => {
    let ended = false;
    let out = '';
    const s = new AnswerStream((x) => (out += x), async () => (ended ? 'Green 2022' : null));
    s.text('Claim <citation id="u-G"/>. After');
    await new Promise((r) => setTimeout(r, 10));
    expect(out).toBe('Claim');
    ended = true;
    await s.finish();
    expect(out).toBe('Claim (Green 2022). After\n');
  });

  it('two tags in a row, the first known late: one bracket in the right order', async () => {
    for (const style of [undefined, { color: false, width: 80 }]) {
      let out = '';
      const names = lateNames({ 'u-W': { name: 'Wong 2020', from: 2 }, 'u-G': { name: 'Green 2022', from: 1 } });
      const s = new AnswerStream((x) => (out += x), names, (x) => x, style);
      const head = 'Claim <citation id="u-W"/> <citation id="u-G"/>. Next';
      s.text(head);
      s.text(`${head} part.`);
      await s.finish();
      expect(out).toContain('Claim (Wong 2020; Green 2022). Next part.');
    }
  });

  it('the same source again after a held citation still shows once until another source', async () => {
    let out = '';
    const s = new AnswerStream((x) => (out += x), lateNames({ 'u-W': { name: 'Wong 2020', from: 2 } }));
    const head = 'A <citation id="u-W"/> B <citation id="u-W"/> C';
    s.text(head);
    s.text(`${head} done.`);
    await s.finish();
    expect(out).toBe('A (Wong 2020) B C done.\n');
  });
});

describe('DisplayNames: missing names while the run is active', () => {
  it('an unknown id is not read again for a moment, read again later, and missing for good only after the run ended', async () => {
    let t = 0;
    let reads = 0;
    let known = false;
    const view = (on: boolean) =>
      ({ thread_id: 't', title: '', blocks: [], citations: { by_key: on ? fixture('thread-run-a').citations.by_key : {} } }) as ThreadView;
    const names = new DisplayNames(async () => {
      reads++;
      return view(known);
    }, 3_000, () => t);
    expect(await names.name(HOLM)).toBeNull();
    const after = reads;
    expect(await names.name(HOLM)).toBeNull();
    expect(reads).toBe(after); // within the short wait
    t += 2_000;
    known = true;
    expect(await names.name(HOLM)).toBe('Holm 2023');
    // After the run ended, one more read decides; then the id is missing for good.
    expect(await names.name('u-NONE0000')).toBeNull();
    names.runEnded();
    const before = reads;
    expect(await names.name('u-NONE0000')).toBeNull();
    expect(reads).toBeGreaterThan(before);
    const final = reads;
    t += 10_000;
    expect(await names.name('u-NONE0000')).toBeNull();
    expect(reads).toBe(final);
  });
});
