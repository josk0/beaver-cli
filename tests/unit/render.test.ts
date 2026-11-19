import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerRenderer, styleSources, toolLabel, visibleLength } from '../../src/modes/render.js';
import { AnswerStream, Spinner } from '../../src/modes/stream.js';

const ESC = '\x1b[';
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Feeds the chunks (a string is text, `{ cite }` a citation) and ends the text. */
function render(chunks: Array<string | { cite: string }>, opts: { color?: boolean; width?: number } = {}): string {
  const r = new AnswerRenderer({ color: opts.color ?? true, width: opts.width ?? 80 });
  let out = '';
  for (const c of chunks) out += typeof c === 'string' ? r.text(c) : r.cite(c.cite);
  return out + r.end();
}

const lines = (s: string) => s.split('\n').filter((l) => l !== '');

const SAMPLE = `## Fairness in **machine** learning

Holm argues that **group fairness** criteria conflict with *individual fairness*, and that the \`equalized_odds\` metric is often misread as a guarantee of equal treatment.

- A first point that is long enough to wrap around the terminal width at least once.
- A second point
  - nested
12. Numbered item that also runs long enough to need a hanging indent here.

\`\`\`
def f(x):  return x * 2   # a long line that is never wrapped, whatever the width of the terminal
\`\`\`

---
Note that a * b, snake_case_name and *args stay as typed.`;

describe('AnswerRenderer', () => {
  it('a chunk boundary inside "**" still gives bold, without the markers', () => {
    for (const chunks of [['Some **bo', 'ld** text'], ['Some *', '*bold*', '* text'], ['Some **bold**', ' text']]) {
      const out = render(chunks);
      expect(out).toBe(`  Some ${B('bold')} text\n`);
    }
  });

  it('holds back a trailing partial word until whitespace or the end', () => {
    const r = new AnswerRenderer({ color: false, width: 80 });
    expect(r.text('Hello wor')).toBe('  Hello');
    expect(r.text('ld, and')).toBe(' world,');
    expect(r.end()).toBe(' and\n');
  });

  it('holds back a lone trailing "*" (it may become "**")', () => {
    const r = new AnswerRenderer({ color: true, width: 80 });
    expect(r.text('a *')).toBe('  a');
    expect(r.text('*b** c')).toBe(` ${B('b')}`);
  });

  it('a heading split across chunks is a bold line without the hashes', () => {
    expect(render(['#', '# Ti', 'tle\nText'])).toBe(`  ${B('Title')}\n  Text\n`);
    expect(render(['## Title\nText'], { color: false })).toBe('  Title\n  Text\n');
    expect(render(['#hashtag'], { color: false })).toBe('  #hashtag\n');
  });

  it('wraps at the width; escape codes do not count toward it and are never cut', () => {
    const text = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `**word${i}**` : `word${i}`)).join(' ');
    const out = render([text], { width: 30 });
    for (const l of lines(out)) {
      expect(visibleLength(l)).toBeLessThanOrEqual(30);
      expect(l.startsWith('  ')).toBe(true);
      // Every escape sequence is whole and closed on its own line.
      expect(l.split(ESC).length).toBe(l.split(`${ESC}0m`).length * 2 - 1);
    }
    expect(lines(out).length).toBeGreaterThan(3);
    expect(out.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\*\*/g, ''));
  });

  it('bullets and numbered items get a hanging indent', () => {
    const out = render(['- one two three four five six seven\n3. alpha beta gamma delta epsilon'], { color: false, width: 22 });
    expect(out).toBe(
      ['  • one two three four', '    five six seven', '  3. alpha beta gamma', '     delta epsilon', ''].join('\n'),
    );
    expect(render(['  - nested'], { color: false })).toBe('    ◦ nested\n');
  });

  it('a fenced code block is printed verbatim, dim, never wrapped, its markup untouched', () => {
    const code = 'x = a_b * c  # **not bold** and a long line that goes past the width';
    const out = render(['Before\n```py\n', code, '\n```\nAfter'], { width: 30 });
    expect(out).toBe(`  Before\n    \x1b[2m${code}\x1b[0m\n  After\n`);
  });

  it('a citation stays whole on a wrapped line, with the punctuation after it', () => {
    const out = render(['The claim holds in most cases', { cite: 'Holm 2023' }, '. Next sentence here.'], { width: 36 });
    expect(out).toBe(`  The claim holds in most\n  cases\x1b[2m(Holm 2023)\x1b[0m. Next sentence\n  here.\n`);
    const spaced = render(['The claim holds in most cases ', { cite: 'Holm 2023' }, '.'], { width: 36, color: false });
    expect(spaced).toBe('  The claim holds in most cases\n  (Holm 2023).\n');
  });

  it('inline code loses its backticks and is cyan; without colour only the backticks go', () => {
    expect(render(['use `a_b` now'])).toBe('  use \x1b[36ma_b\x1b[0m now\n');
    expect(render(['use `a b` now'], { color: false })).toBe('  use a b now\n');
  });

  it('italic only for clear spans; "a * b", snake_case and a stray "*" stay as typed', () => {
    expect(render(['an *important* point'])).toBe('  an \x1b[3mimportant\x1b[0m point\n');
    expect(render(['a *very big* deal'])).toBe('  a \x1b[3mvery\x1b[0m \x1b[3mbig\x1b[0m deal\n');
    expect(render(['_this_ one'])).toBe('  \x1b[3mthis\x1b[0m one\n');
    for (const t of ['a * b = c', 'snake_case_name here', 'call *args and stop', '2*3*4 is 24', 'a _b c']) {
      expect(render([t])).toBe(`  ${t}\n`);
    }
  });

  it('without colour: markers removed, layout kept, no escape code at all', () => {
    const out = render([SAMPLE], { color: false, width: 40 });
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).toContain('  Fairness in machine learning\n');
    expect(out).toContain('  • A first point');
  });

  it('collapses blank lines and drops leading ones', () => {
    expect(render(['\n\nOne\n\n\n\nTwo\n'], { color: false })).toBe('  One\n\n  Two\n');
  });

  it('gives the same output for one chunk and for a chunk per character', () => {
    for (const color of [true, false]) {
      for (const width of [24, 40, 90]) {
        const whole = render([SAMPLE], { color, width });
        expect(render([...SAMPLE], { color, width })).toBe(whole);
        // Also for chunks of varying size.
        const parts: string[] = [];
        for (let i = 0, n = 1; i < SAMPLE.length; i += n, n = (n % 7) + 1) parts.push(SAMPLE.slice(i, i + n));
        expect(render(parts, { color, width })).toBe(whole);
      }
    }
  });
});

describe('AnswerStream, styled', () => {
  const names = async (id: string) => (id === 'u-AAAA1111' ? 'Holm 2023' : null);
  const make = (width = 40) => {
    let out = '';
    const s = new AnswerStream((t) => (out += t), names, (t) => t, { color: true, width });
    return { s, out: () => out };
  };

  it('gives the same output whether the raw text grows one character per poll or arrives at once', async () => {
    const raw = `${SAMPLE.slice(0, 200)} <citation id="u-AAAA1111"/>, then <citation id="u-AAAA1111"/> more <citation id="u-ZZZZ"/>text.\n\n${SAMPLE.slice(200)}`;
    const a = make();
    a.s.text(raw);
    await a.s.finish();
    const b = make();
    for (let i = 1; i <= raw.length; i++) b.s.text(raw.slice(0, i));
    await b.s.finish();
    expect(b.out()).toBe(a.out());
    expect(a.out()).toContain('\x1b[2m(Holm 2023)\x1b[0m,');
    expect(a.out()).not.toContain('citation');
  });

  it('tool lines: friendly labels, a count for repeats, a blank line before the answer', async () => {
    let out = '';
    const s = new AnswerStream((t) => (out += t), names, (t) => t, { color: false, width: 40 });
    s.tool('item_search_by_topic');
    s.tool('extract');
    s.tool('extract');
    s.tool('extract');
    s.text('The answer.');
    await s.finish();
    expect(out).toBe(
      '  · Searching the library by topic\n  · Reading documents\r  · Reading documents ×2\r  · Reading documents ×3\n\n  The answer.\n',
    );
  });

  it('a tool call in the middle of the answer sits between blank lines', async () => {
    const { s, out } = make();
    s.text('Looking.');
    s.tool('item_search_by_topic');
    s.text('Looking.\nFound it.');
    await s.finish();
    expect(out()).toBe('  Looking.\n\n  \x1b[2m· Searching the library by topic\x1b[0m\n\n  Found it.\n');
  });

  it('settle(true) shows what is still held back (a stopped run)', async () => {
    const { s, out } = make();
    s.text('Text\n```\nx = 1');
    await s.settle(true);
    expect(out()).toBe('  Text\n    \x1b[2mx = 1\x1b[0m\n');
  });

  it('settle ends the open line (a question can follow)', async () => {
    const { s, out } = make();
    s.text('Half a sente');
    await s.settle();
    expect(out()).toBe('  Half a sente\n');
  });
});

describe('toolLabel', () => {
  it('maps known names and makes the rest readable', () => {
    expect(toolLabel('item_search_by_topic')).toBe('Searching the library by topic');
    expect(toolLabel('extract')).toBe('Reading documents');
    expect(toolLabel('find_related_items')).toBe('Find related items');
  });
});

describe('Spinner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redraws about every 100 ms and is cleared before the first output; then stays quiet', () => {
    vi.useFakeTimers();
    let out = '';
    const raw = (s: string) => (out += s);
    const sp = new Spinner(raw, true);
    const write = (s: string) => {
      sp.stop();
      raw(s);
    };
    sp.start();
    vi.advanceTimersByTime(250);
    expect(out.split('Thinking…').length - 1).toBe(3);
    expect(out.startsWith('\r  \x1b[2m⠋ Thinking…')).toBe(true);
    write('  The answer');
    expect(out.endsWith('\r\x1b[2K  The answer')).toBe(true);
    const before = out;
    vi.advanceTimersByTime(1000);
    expect(out).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('without colour it clears with spaces, no escape code', () => {
    vi.useFakeTimers();
    let out = '';
    const sp = new Spinner((s) => (out += s), false);
    sp.start();
    sp.stop();
    sp.stop();
    expect(out).toBe(`\r  ⠋ Thinking…\r${' '.repeat(13)}\r`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('citations in a row and the source list', () => {
  it('sets two different citations in a row apart with a space, however they arrive', () => {
    const r = new AnswerRenderer({ color: false, width: 80 });
    const out = r.text('Metrics conflict.') + r.text(' ') + r.cite('Green 2022') + r.text('') + r.cite('⁨Wong⁩ 2020') + r.text(' Next.') + r.end();
    expect(out).toContain('(Green 2022) (Wong 2020) Next.');
  });

  it('wraps a long source entry with a hanging indent inside the width', () => {
    const list = `[1] ${'Author Name, '.repeat(8)}(2021). A Long Title.\n    zotero://select/library/items/ABCD1234`;
    const lines = styleSources(list, { color: false, width: 60 }).split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
    expect(lines[1].startsWith('    [1] Author')).toBe(true);
    expect(lines[2].startsWith('        ')).toBe(true);
    expect(lines.at(-1)).toBe('        zotero://select/library/items/ABCD1234');
  });
});
