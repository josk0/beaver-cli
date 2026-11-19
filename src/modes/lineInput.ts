import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

/** Lines typed at the interactive prompt. */
export interface LineInput {
  /**
   * Shows `prompt` and returns the next line, or null at end of input or when `signal` aborts.
   * `history`: the line goes into the up/down history (messages and commands, not answers).
   */
  read(opts: { prompt: string; signal?: AbortSignal; history?: boolean }): Promise<string | null>;
  /** Drops the lines that arrived before a read asked for them; returns how many. */
  discard(): number;
  close(): void;
}

/** Entries in arrival order, handed to waiting reads; ended at end of input. */
class LineQueue<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(line: T | null) => void> = [];
  ended = false;

  push(line: T): void {
    const w = this.waiters.shift();
    if (w) w(line);
    else this.queue.push(line);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  next(signal?: AbortSignal, onWait?: () => void, onAbort?: () => void): Promise<T | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended || signal?.aborted) return Promise.resolve(null);
    onWait?.();
    return new Promise((resolve) => {
      const waiter = (line: T | null) => {
        signal?.removeEventListener('abort', abort);
        resolve(line);
      };
      const abort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        onAbort?.();
        resolve(null);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  discard(): number {
    return this.queue.splice(0).length;
  }
}

/** Piped or non-terminal input: the prompt is written as text, lines are read as they come. */
export class PlainInput implements LineInput {
  private readonly lines = new LineQueue<string>();
  private readonly rl: Interface;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly write: (s: string) => void,
  ) {
    this.rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.lines.push(line));
    this.rl.on('close', () => this.lines.end());
  }

  read(opts: { prompt: string; signal?: AbortSignal }): Promise<string | null> {
    this.write(opts.prompt);
    return this.lines.next(opts.signal);
  }

  discard(): number {
    return this.lines.discard();
  }

  close(): void {
    this.rl.close();
  }
}

/** Lines that arrive within this long of each other are one paste: one message. */
export const PASTE_MS = 30;

/**
 * A terminal at both ends: line editing and history through readline, which draws the prompt. Its
 * echo is muted except while a read waits, so streamed output never meets the edit line; keys typed
 * meanwhile wait in the line buffer and appear when the prompt is drawn again. Ctrl-C reaches
 * `onInterrupt` with the line typed so far.
 */
export class TerminalInput implements LineInput {
  /** Each line with the number of typed lines it joins (a paste is several). */
  private readonly lines = new LineQueue<{ text: string; pieces: number }>();
  private readonly rl: Interface;
  private muted = true;
  private pending: string[] = [];
  private pasteTimer: NodeJS.Timeout | null = null;
  onInterrupt: (line: string) => void = () => {};

  constructor(
    input: NodeJS.ReadableStream,
    output: { write(s: string): unknown; columns?: number },
    private readonly pasteMs = PASTE_MS,
  ) {
    const echo = new Writable({
      write: (chunk, _enc, done) => {
        if (!this.muted) output.write(chunk.toString());
        done();
      },
    });
    Object.defineProperty(echo, 'columns', { get: () => output.columns ?? 80 });
    Object.defineProperty(echo, 'isTTY', { value: true });
    this.rl = createInterface({ input, output: echo, terminal: true, historySize: 200, removeHistoryDuplicates: true });
    this.rl.on('line', (line) => {
      this.pending.push(line);
      if (this.pasteTimer) clearTimeout(this.pasteTimer);
      this.pasteTimer = setTimeout(() => this.flush(), this.pasteMs);
    });
    this.rl.on('SIGINT', () => this.onInterrupt(this.rl.line));
    this.rl.on('close', () => {
      this.flush();
      this.lines.end();
    });
  }

  private flush(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = null;
    if (this.pending.length === 0) return;
    this.lines.push({ text: this.pending.join('\n'), pieces: this.pending.length });
    this.pending = [];
  }

  async read(opts: { prompt: string; signal?: AbortSignal; history?: boolean }): Promise<string | null> {
    this.rl.setPrompt(opts.prompt);
    const got = await this.lines.next(
      opts.signal,
      () => {
        this.muted = false;
        this.rl.prompt(true);
      },
      () => {
        // Released while the person types: the half-typed answer goes.
        this.muted = true;
        this.clearLine();
      },
    );
    this.muted = true;
    if (got === null) return null;
    this.fixHistory(got.text, got.pieces, opts.history === true);
    return got.text;
  }

  /** readline records every typed line; keep messages and commands, as one entry per paste, and no answers. */
  private fixHistory(line: string, n: number, keep: boolean): void {
    const history = (this.rl as unknown as { history?: string[] }).history;
    if (!history) return;
    if (!keep || n > 1) history.splice(0, Math.min(n, history.length));
    if (keep && n > 1) history.unshift(line.replace(/\n/g, ' '));
  }

  /** Clears the line typed at the prompt (the prompt stays). */
  clearLine(): void {
    this.rl.write(null, { ctrl: true, name: 'e' });
    this.rl.write(null, { ctrl: true, name: 'u' });
  }

  discard(): number {
    return this.lines.discard();
  }

  close(): void {
    this.flush();
    this.rl.close();
  }
}
