/**
 * Streaming renderer for an answer on a terminal: light markdown (bold, italic, headings, lists,
 * inline code, code blocks, rules), a left indent and word wrap. Text arrives in chunks of any size;
 * the output does not depend on where the chunks were cut. A partial word, a line start that may
 * still turn into a list marker or a heading, and a code line are held back until they are complete.
 */

export interface RenderOptions {
  /** ANSI styles; without them the markers are still removed and the layout still applied. */
  color: boolean;
  /** Total line width, the indent included. */
  width: number;
  /** Spaces before every line; 2 when unset. */
  indent?: number;
}

/** Stands for a citation inside the buffered text; the names wait in a queue. */
const CITE = '';

const ITALIC_OPEN = /^[(["'“‘]*([*_])(?=[^*_\s])/;
const TRAIL = /[)\]"'”’.,;:!?]*$/;
/** How many words an italic opener may wait for its closer before it is shown as typed. */
const MAX_ITALIC_HOLD = 12;

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  cite?: boolean;
}

interface Run extends RunStyle {
  text: string;
}

type LineHead =
  | { kind: 'blank' | 'fence' | 'rule'; len: number }
  | { kind: 'heading' | 'para'; len: number }
  | { kind: 'item'; len: number; lead: string };

/** Visible length: code points, escape codes excluded. */
export function visibleLength(s: string): number {
  return [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

export function sgr(text: string, style: RunStyle & { dim?: boolean }, color: boolean): string {
  if (!color || text === '') return text;
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim || style.cite) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.code) codes.push(36);
  return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
}

/**
 * How the line in `buf` starts, or null when that cannot be told yet. `complete` says whether the
 * whole line is in `buf` (a newline follows, or the text ended).
 */
function classify(line: string, complete: boolean, nlLen: number): LineHead | null {
  if (!complete) {
    if (
      /^[ \t\r]*$/.test(line) ||
      /^ {0,3}(`{1,2}|~{1,2})$/.test(line) ||
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}([-*_])([ \t]*\1)*[ \t]*$/.test(line) ||
      /^ {0,3}#{1,6}$/.test(line) ||
      /^[ \t]*[-*+]$/.test(line) ||
      /^[ \t]*\d{1,9}[.)]?$/.test(line)
    ) {
      return null;
    }
  }
  const whole = line.length + nlLen;
  if (/^[ \t\r]*$/.test(line)) return { kind: 'blank', len: whole };
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return { kind: 'fence', len: whole };
  if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t\r]*$/.test(line)) return { kind: 'rule', len: whole };
  let m = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(line);
  if (m) return { kind: 'heading', len: m[0].length };
  m = /^([ \t]*)[-*+][ \t]+/.exec(line);
  if (m) {
    const nest = Math.min(m[1].replace(/\t/g, '    ').length, 8);
    return { kind: 'item', len: m[0].length, lead: `${' '.repeat(nest)}${nest >= 2 ? '◦' : '•'} ` };
  }
  m = /^([ \t]*)(\d{1,9}[.)])[ \t]+/.exec(line);
  if (m) {
    const nest = Math.min(m[1].replace(/\t/g, '    ').length, 8);
    return { kind: 'item', len: m[0].length, lead: `${' '.repeat(nest)}${m[2]} ` };
  }
  return { kind: 'para', len: /^[ \t]*/.exec(line)![0].length };
}

export class AnswerRenderer {
  private readonly color: boolean;
  private readonly pad: string;
  /** Room for the line after the indent. */
  private readonly room: number;

  private buf = '';
  private readonly names: string[] = [];
  private ended = false;

  // The input line being read.
  private atStart = true;
  private inFence = false;
  private heading = false;
  private lead = '';
  private leadShown = false;
  private word = '';
  private space = false;

  // Inline state of the line, as parsed so far.
  private bold = false;
  private code = false;
  private italic = false;
  /** Words held while an italic opener waits for its closer: the opener's marker and the words. */
  private held: { marker: string; words: string[] } | null = null;

  // The output line.
  private lineOpen = false;
  private col = 0;
  /** The last output line was blank, or nothing was written yet: a blank input line adds nothing. */
  private lastBlank = true;

  constructor(opts: RenderOptions) {
    this.color = opts.color;
    const indent = opts.indent ?? 2;
    this.pad = ' '.repeat(indent);
    this.room = Math.max(opts.width - indent, 10);
  }

  /** Text of the answer; returns what may be shown now. */
  text(s: string): string {
    if (s !== '') this.afterCite = false;
    this.buf += s.replace(//g, '');
    return this.pump();
  }

  /** True while nothing followed the last citation: the next one is set off by a space. */
  private afterCite = false;

  /** A citation, shown as `(name)`; it sticks to the text around it like a word. */
  cite(name: string): string {
    if (this.afterCite) this.buf += ' ';
    this.afterCite = true;
    this.buf += CITE;
    this.names.push(name.replace(/[\u2066-\u2069\u200e\u200f]/g, ''));
    return this.pump();
  }

  /**
   * Something else is shown next (a tool line, a question): shows the word held back and ends the
   * output line. The text that follows continues on a new line.
   */
  interrupt(): string {
    let out = this.pump();
    if (!this.inFence) {
      out += this.endWord();
      out += this.releaseHeld();
    }
    if (this.lineOpen) out += '\n';
    this.lineOpen = false;
    this.lastBlank = true;
    return out;
  }

  /** The text ended: shows everything held back and ends the line. */
  end(): string {
    this.ended = true;
    let out = this.pump();
    if (!this.atStart) out += this.endInputLine();
    return out;
  }

  private pump(): string {
    let out = '';
    for (;;) {
      if (this.inFence) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0 && (!this.ended || this.buf === '')) return out;
        const line = nl < 0 ? this.buf : this.buf.slice(0, nl);
        this.buf = nl < 0 ? '' : this.buf.slice(nl + 1);
        if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
          this.inFence = false;
          continue;
        }
        out += this.codeLine(line);
        continue;
      }
      if (this.atStart) {
        if (this.buf === '') return out;
        const nl = this.buf.indexOf('\n');
        const line = nl < 0 ? this.buf : this.buf.slice(0, nl);
        const head = classify(line, nl >= 0 || this.ended, nl >= 0 ? 1 : 0);
        if (head === null) return out;
        this.buf = this.buf.slice(head.len);
        if (head.kind === 'blank') {
          if (!this.lastBlank) out += '\n';
          this.lastBlank = true;
          continue;
        }
        if (head.kind === 'fence') {
          this.inFence = true;
          continue;
        }
        if (head.kind === 'rule') {
          out += `${this.pad}${sgr('─'.repeat(Math.min(this.room, 40)), { dim: true }, this.color)}\n`;
          this.lastBlank = false;
          continue;
        }
        this.atStart = false;
        this.heading = head.kind === 'heading';
        this.lead = head.kind === 'item' ? head.lead : '';
        this.leadShown = false;
      }
      let i = 0;
      let lineEnd = false;
      for (; i < this.buf.length; i++) {
        const ch = this.buf[i];
        if (ch === '\n') {
          lineEnd = true;
          i++;
          break;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
          out += this.endWord();
          this.space = true;
        } else this.word += ch;
      }
      this.buf = this.buf.slice(i);
      if (lineEnd) {
        out += this.endInputLine();
        continue;
      }
      if (this.ended) out += this.endInputLine();
      return out;
    }
  }

  private codeLine(line: string): string {
    this.lastBlank = false;
    const text = line.replace(/\r$/, '');
    return text === '' ? '\n' : `${this.pad}  ${sgr(text, { dim: true }, this.color)}\n`;
  }

  private endInputLine(): string {
    let out = this.endWord();
    out += this.releaseHeld();
    if (this.lineOpen) {
      out += '\n';
      this.lastBlank = false;
    }
    this.lineOpen = false;
    this.atStart = true;
    this.space = false;
    this.bold = this.code = this.italic = false;
    return out;
  }

  /** The word just completed: shown, or held while an italic span may still close. */
  private endWord(): string {
    const word = this.word;
    if (word === '') return '';
    this.word = '';
    if (this.held) {
      this.held.words.push(word);
      if (closes(word, this.held.marker, false)) return this.flushHeld(true);
      if (this.held.words.length >= MAX_ITALIC_HOLD) return this.flushHeld(false);
      return '';
    }
    if (!this.code && !this.italic) {
      const m = ITALIC_OPEN.exec(word);
      if (m) {
        const marker = m[1];
        if (closes(word, marker, true)) return this.place(this.parse(word, marker, true, true));
        this.held = { marker, words: [word] };
        return '';
      }
    }
    return this.place(this.parse(word));
  }

  /** Shows the held words as typed (the opener never closed). */
  private releaseHeld(): string {
    return this.held ? this.flushHeld(false) : '';
  }

  private flushHeld(italic: boolean): string {
    const { marker, words } = this.held!;
    this.held = null;
    let out = '';
    words.forEach((w, k) => {
      const runs = italic ? this.parse(w, marker, k === 0, k === words.length - 1) : this.parse(w);
      out += this.place(runs);
      this.space = true;
    });
    this.space = false;
    return out;
  }

  /**
   * The word as styled runs, the inline state carried across words. With a marker, an italic opener
   * at its start and/or a closer at its end are taken out.
   */
  private parse(word: string, marker?: string, open = false, close = false): Run[] {
    const runs: Run[] = [];
    let cur = '';
    const flush = () => {
      if (cur !== '') runs.push({ text: cur, bold: this.bold || this.heading, italic: this.italic, code: this.code });
      cur = '';
    };
    const openAt = open && marker ? ITALIC_OPEN.exec(word)![0].length - 1 : -1;
    const closeAt = close && marker ? word.length - TRAIL.exec(word)![0].length - 1 : -1;
    const stars = /^\*+$/.test(word);
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      if (ch === CITE) {
        flush();
        runs.push({ text: `(${this.names.shift() ?? ''})`, cite: true, bold: this.heading });
        continue;
      }
      if (this.code) {
        if (ch === '`') {
          flush();
          this.code = false;
        } else cur += ch;
        continue;
      }
      if (i === openAt) {
        flush();
        this.italic = true;
        continue;
      }
      if (i === closeAt) {
        flush();
        this.italic = false;
        continue;
      }
      if (ch === '`') {
        flush();
        this.code = true;
        continue;
      }
      if (ch === '*' && word[i + 1] === '*' && !stars) {
        flush();
        this.bold = !this.bold;
        i++;
        continue;
      }
      cur += ch;
    }
    flush();
    return runs;
  }

  /** Puts a word on the output line, wrapping before it when it does not fit. */
  private place(runs: Run[]): string {
    const len = runs.reduce((n, r) => n + visibleLength(r.text), 0);
    if (len === 0) return '';
    let out = '';
    if (!this.lineOpen) {
      const lead = this.leadShown ? ' '.repeat(this.lead.length) : this.lead;
      this.leadShown = true;
      out += this.pad + lead;
      this.col = lead.length;
      this.lineOpen = true;
    } else if (this.space) {
      if (this.col + 1 + len > this.room && this.col > this.lead.length) {
        out += `\n${this.pad}${' '.repeat(this.lead.length)}`;
        this.col = this.lead.length;
      } else {
        out += ' ';
        this.col += 1;
      }
    }
    this.space = false;
    for (const r of runs) out += sgr(r.text, r, this.color);
    this.col += len;
    return out;
  }
}

/** True when the word ends an italic span opened with `marker` (in the same word, when `same`). */
function closes(word: string, marker: string, same: boolean): boolean {
  const core = word.slice(0, word.length - TRAIL.exec(word)![0].length);
  if (core.length < (same ? 3 : 2) || core[core.length - 1] !== marker) return false;
  const before = core[core.length - 2];
  if (before === '*' || before === '_' || /\s/.test(before)) return false;
  if (same) {
    const openAt = ITALIC_OPEN.exec(word)![0].length - 1;
    return core.length - 1 > openAt + 1;
  }
  return true;
}

const TOOL_LABELS: Record<string, string> = {
  item_search_by_topic: 'Searching the library by topic',
  item_search: 'Searching the library',
  item_search_by_metadata: 'Searching the library by author and title',
  extract: 'Reading documents',
  view: 'Looking at pages',
  create_note: 'Drafting a note',
  edit_note: 'Editing a note',
  edit_note_batch: 'Editing notes',
  create_item: 'Drafting a new item',
  create_collection: 'Drafting a collection',
};

/** A tool's name as a short phrase: from the map, else underscores as spaces and a capital first letter. */
export function toolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  const words = name.replace(/_+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** The source list under a bold heading, each line indented, wrapped with a hanging indent, and dim. */
export function styleSources(list: string, opts: { color: boolean; indent?: number; width?: number }): string {
  const pad = ' '.repeat(opts.indent ?? 2);
  const width = opts.width ?? 80;
  const lines: string[] = [];
  for (const raw of list.replace(/[\u2066-\u2069\u200e\u200f]/g, '').split('\n')) {
    const lead = `${pad}  ${/^\s*/.exec(raw)![0]}`;
    const hang = /^\[\d+\] /.test(raw) ? `${pad}      ` : lead;
    let line = lead;
    for (const word of raw.trim().split(/\s+/)) {
      const start = line === lead || line === hang;
      if (!start && line.length + 1 + word.length > width) {
        lines.push(line);
        line = hang + word;
      } else line += (start ? '' : ' ') + word;
    }
    lines.push(line);
  }
  const body = lines.map((l) => {
    const at = /^\s*/.exec(l)![0].length;
    return l.slice(0, at) + sgr(l.slice(at), { dim: true }, opts.color);
  });
  return `${pad}${sgr('Sources', { bold: true }, opts.color)}\n${body.join('\n')}`;
}
