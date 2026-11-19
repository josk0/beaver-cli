import { CITATION_GROUP, codeRanges, groupTags } from '../core/result.js';
import { AnswerRenderer, sgr, toolLabel, type RenderOptions } from './render.js';

/** Styled output for a terminal: the answer through the markdown renderer, friendly tool lines. */
export type StreamStyle = Pick<RenderOptions, 'color' | 'width'>;

type Part = { text: string } | { lead: string; name: string };

/** A citation whose name is not known yet holds the text from it on for at most this long. */
export const HOLD_MS = 6_000;
/** While a citation is held, its name is looked up again this often, also when no new text arrives. */
const RETRY_MS = 500;

/**
 * Prints a run's answer as it is written: only the new part of the run's raw text, appended. Citation
 * tags become `(Display Name)`; no part of a tag is ever shown. Work is queued so that text, tool lines
 * and a final flush keep their order while a name is being looked up.
 */
export class AnswerStream {
  private chain: Promise<void> = Promise.resolve();
  /** The last raw text seen, and how much of it is handled (printed or dropped). */
  private raw = '';
  private done = 0;
  private lineOpen = false;
  private printed = false;
  private broken = false;
  /** The citation shown last: the same source again is not repeated until another source is cited. */
  private lastCite: string | null = null;
  /** Since when the citation group starting at this offset waits for a name. */
  private readonly heldSince = new Map<number, number>();
  private retry: ReturnType<typeof setTimeout> | null = null;

  // Styled mode only.
  private readonly renderer: AnswerRenderer | null;
  /** What was shown last: a blank line separates the tool lines from the answer. */
  private section: 'none' | 'activity' | 'answer' = 'none';
  /** The tool line that is open (no newline yet), so the same tool again updates its count. */
  private toolLine: { label: string; count: number } | null = null;

  constructor(
    private readonly write: (s: string) => void,
    private readonly nameOf: (citationId: string) => Promise<string | null>,
    private readonly dim: (s: string) => string = (s) => s,
    private readonly style?: StreamStyle,
    private readonly now: () => number = Date.now,
  ) {
    this.renderer = style ? new AnswerRenderer(style) : null;
  }

  /** True when the text stopped being a continuation of what was shown. */
  get abandoned(): boolean {
    return this.broken;
  }

  /** True once some text of the answer was shown. */
  get shown(): boolean {
    return this.printed;
  }

  /** The run's full raw text so far. */
  text(raw: string): void {
    this.enqueue(() => this.advance(raw, false));
  }

  /** A tool line, on a line of its own. Styled mode shows Beaver's label when there is one. */
  tool(name: string, label?: string | null): void {
    this.enqueue(() => {
      if (this.style) return this.styledTool(label?.trim() || toolLabel(name));
      this.endLine();
      this.write(`${this.dim(`· ${name}`)}\n`);
    });
  }

  /** True once anything of this run was shown: a tool line or text. */
  get started(): boolean {
    return this.printed || this.section !== 'none';
  }

  /**
   * Waits for queued output, then ends the line that is open. With `last` (the run is over, it did
   * not finish well), styled mode also shows what the renderer still holds back.
   */
  settle(last = false): Promise<void> {
    if (last) {
      this.stopRetry();
      // The run is over: text held back for a name is shown now, with the names found by then.
      this.enqueue(() => this.advance(this.raw, true));
    }
    this.enqueue(() => (last && this.renderer ? this.styledEnd(this.renderer.end()) : this.endLine()));
    return this.chain;
  }

  /** The run ended well: ends the line after the last text, a lone "<" that was held back included. */
  finish(): Promise<void> {
    this.stopRetry();
    this.enqueue(async () => {
      await this.advance(this.raw, true);
      if (this.renderer) this.styledEnd(this.renderer.end());
      else this.endLine();
    });
    return this.chain;
  }

  private stopRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  /** Looks up a held citation again soon, when no new text has moved the stream on meanwhile. */
  private scheduleRetry(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.enqueue(() => this.advance(this.raw, false));
    }, RETRY_MS);
    this.retry.unref?.();
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.chain = this.chain.then(task).catch(() => {});
  }

  private endLine(): void {
    if (this.renderer) return this.styledEnd(this.renderer.interrupt());
    if (this.lineOpen) this.write('\n');
    this.lineOpen = false;
  }

  /** Writes what the renderer gave and closes an open tool line. */
  private styledEnd(rest: string): void {
    this.styledText(rest);
    if (this.toolLine) this.write('\n');
    this.toolLine = null;
  }

  private styledText(s: string): void {
    if (s === '') return;
    let lead = '';
    if (this.toolLine) lead += '\n';
    if (this.section === 'activity') lead += '\n';
    this.toolLine = null;
    this.section = 'answer';
    this.write(lead + s);
    if (s.trim() !== '') this.printed = true;
  }

  private styledTool(label: string): void {
    this.styledText(this.renderer!.interrupt());
    const line = (count: number) => `  ${sgr(`· ${label}${count > 1 ? ` ×${count}` : ''}`, { dim: true }, this.style!.color)}`;
    if (this.toolLine?.label === label) {
      this.toolLine.count++;
      this.write(`\r${line(this.toolLine.count)}`);
      return;
    }
    let lead = '';
    if (this.toolLine) lead = '\n';
    else if (this.section === 'answer') lead = '\n';
    this.toolLine = { label, count: 1 };
    this.section = 'activity';
    this.write(lead + line(1));
  }

  private async advance(raw: string, final: boolean): Promise<void> {
    if (this.broken) return;
    if (!raw.startsWith(this.raw)) {
      this.broken = true;
      return;
    }
    this.raw = raw;
    const end = this.safeEnd(raw, final);
    if (end <= this.done) return;
    const { parts, stop } = await this.render(raw.slice(0, end), this.done, final);
    this.done = stop ?? end;
    if (stop !== undefined) this.scheduleRetry();
    if (this.renderer) {
      let out = '';
      for (const p of parts) out += 'text' in p ? this.renderer.text(p.text) : this.renderer.text(p.lead) + this.renderer.cite(p.name);
      this.styledText(out);
      return;
    }
    let segment = parts.map((p) => ('text' in p ? p.text : `${p.lead}(${p.name})`)).join('');
    if (!this.lineOpen) segment = segment.replace(/^\n+/, '');
    if (segment === '') return;
    this.write(segment);
    this.lineOpen = !segment.endsWith('\n');
    if (segment.trim() !== '') this.printed = true;
  }

  /**
   * How much of the text may be shown now. While the run goes on: not from the last `<` that can still
   * become a citation tag; not a group of citations at the end (a citation may follow and join its
   * bracket); not a citation after a code span that is still open on its line (it may turn out to be
   * code); and not the trailing whitespace (the next text may continue or replace it).
   */
  private safeEnd(raw: string, final: boolean): number {
    let end = raw.length;
    const lt = raw.lastIndexOf('<');
    // At the end of a finished run a lone "<" is text; a longer unclosed fragment is a cut-off tag.
    if (lt >= this.done && couldBeCitationTag(raw.slice(lt)) && !(final && lt === raw.length - 1)) end = lt;
    if (!final) {
      const trailing = /(?:[ \t]*(?:<citation\b[^>]*>|<\/citation\s*>))+[ \t]*$/.exec(raw.slice(0, end));
      if (trailing && trailing.index >= this.done) end = trailing.index;
      end = Math.min(end, this.openSpanTag(raw.slice(0, end)));
    }
    while (end > this.done && /\s/.test(raw[end - 1])) end--;
    return Math.max(end, this.done);
  }

  /** Where the first citation after a code span still open on its line starts (its blanks included), or the text's length. */
  private openSpanTag(text: string): number {
    const ranges = codeRanges(text);
    const inCode = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
    for (const m of text.slice(this.done).matchAll(/[ \t]*<citation\b/g)) {
      const at = this.done + m.index;
      if (inCode(at + m[0].length - '<citation'.length)) continue;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      let ticks = false;
      for (let i = lineStart; i < at; i++) if (text[i] === '`' && !inCode(i)) ticks = true;
      if (ticks) return at;
    }
    return text.length;
  }

  /**
   * `text` from `from` on, each group of citations in a row as one bracket of names, or removed. Tags
   * inside code blocks and code spans stay as written. While the run goes on, a group with a citation
   * whose name is not known yet stops the rendering (`stop`, the group's start) until the name arrives
   * or the group has waited HOLD_MS; then, and at the end of the run, an unknown citation is dropped.
   */
  private async render(text: string, from: number, final: boolean): Promise<{ parts: Part[]; stop?: number }> {
    const ranges = codeRanges(text);
    const inCode = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
    const segment = text.slice(from);
    const out: Part[] = [];
    let last = 0;
    for (const m of segment.matchAll(CITATION_GROUP)) {
      const lead = m[0].match(/^[ \t]*/)![0];
      if (inCode(from + m.index + lead.length)) continue;
      const found: Array<string | null> = [];
      for (const { attrs } of groupTags(m[0])) {
        let name: string | null = null;
        if (attrs.id) {
          try {
            name = await this.nameOf(attrs.id);
          } catch {
            name = null;
          }
        }
        found.push(name);
      }
      const at = from + m.index;
      if (!final && found.includes(null)) {
        const since = this.heldSince.get(at) ?? this.now();
        this.heldSince.set(at, since);
        if (this.now() - since < HOLD_MS) {
          const between = segment.slice(last, m.index);
          if (between) out.push({ text: between });
          return { parts: out, stop: at };
        }
      }
      this.heldSince.delete(at);
      const between = segment.slice(last, m.index);
      if (between) out.push({ text: between });
      last = m.index + m[0].length;
      const names: string[] = [];
      for (const name of found) {
        // The same source again is not repeated until another source is cited.
        if (name && name !== this.lastCite) {
          names.push(name);
          this.lastCite = name;
        }
      }
      if (names.length) out.push({ lead, name: names.join('; ') });
    }
    const rest = segment.slice(last);
    if (rest) out.push({ text: rest });
    return { parts: out };
  }
}

const OPEN = '<citation';
const CLOSE = '</citation';

/** A tail that starts with `<` and may still turn into a citation tag: a prefix of one, or one not yet closed. */
function couldBeCitationTag(tail: string): boolean {
  if (tail.includes('>')) return false;
  return OPEN.startsWith(tail) || CLOSE.startsWith(tail) || tail.startsWith(OPEN) || tail.startsWith(CLOSE);
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/**
 * A "Thinking…" line redrawn in place until `stop`, which clears it. The timer does not keep the
 * process alive.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private readonly text = 'Thinking…';

  constructor(
    private readonly write: (s: string) => void,
    private readonly color: boolean,
    private readonly intervalMs = 100,
  ) {}

  start(): void {
    if (this.timer) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Clears the line; safe to call any number of times. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // Without colour no escape code at all: overwrite with spaces.
    this.write(this.color ? '\r\x1b[2K' : `\r${' '.repeat(this.text.length + 4)}\r`);
  }

  private draw(): void {
    const f = [...FRAMES][this.frame++ % [...FRAMES].length];
    this.write(`\r  ${sgr(`${f} ${this.text}`, { dim: true }, this.color)}`);
  }
}
