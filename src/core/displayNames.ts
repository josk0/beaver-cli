import type { ThreadView } from '../client/types.js';
import { displayNamesOf } from './result.js';

/** How long one lookup may hold up the text that waits for it. */
const LOOKUP_MS = 3_000;

/** `run`: the citations of the answer being written; `chat`: those of the whole chat. */
export type NameScope = 'run' | 'chat';

/**
 * The display names ("Holm 2023") of the items a running answer cites, read from Beaver's own
 * citations: first those of the run's answer, then, for a name still missing, those of the whole chat
 * (a run's answer holds only the text after its last tool call, so a citation in an earlier sentence
 * of the run is found only there). One read serves every name cited so far; at most one read per
 * scope is in flight. Never throws: a failure, a slow answer or an unknown id is a null, and a name
 * that was found is kept for the session.
 */
/** While the run is active, an id no read could name is not read again for this long. */
const MISSING_MS = 1_500;

export class DisplayNames {
  private readonly names = new Map<string, string>();
  /**
   * Ids no read could name: until a time while the run is active (its citations may still arrive), or
   * for the rest of the run ('final') once a read made after the run finished could not name them.
   */
  private readonly missing = new Map<string, number | 'final'>();
  private readonly reading = new Map<NameScope, { p: Promise<boolean>; afterEnd: boolean }>();
  private ended = false;

  /** `read` returns the citations of that scope, or null when there is no run or chat yet. */
  constructor(
    private readonly read: (scope: NameScope) => Promise<ThreadView | null>,
    private readonly lookupMs = LOOKUP_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** `id` is the tag's id, `<library_ref>-<zotero_key>`, e.g. `u-PVX9VYC4`. */
  async name(id: string): Promise<string | null> {
    const known = this.names.get(id);
    if (known !== undefined) return known;
    const miss = this.missing.get(id);
    if (miss === 'final' || (typeof miss === 'number' && this.now() < miss)) return null;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.lookupMs);
    });
    try {
      const afterEnd = this.ended;
      let answered = true;
      for (const scope of ['run', 'chat'] as const) {
        const ok = await Promise.race([this.startRead(scope), slow]);
        if (timedOut || this.names.has(id)) break;
        answered &&= ok === true;
      }
      // Only reads that answered prove the id unknown; a slow or failed one does not.
      if (!timedOut && answered && !this.names.has(id)) this.missing.set(id, afterEnd ? 'final' : this.now() + MISSING_MS);
    } finally {
      clearTimeout(timer);
    }
    return this.names.get(id) ?? null;
  }

  /** A name already found, without reading. */
  known(id: string): string | null {
    return this.names.get(id) ?? null;
  }

  /** A new run starts: ids that could not be named are tried again. */
  newRun(): void {
    this.ended = false;
    this.missing.clear();
  }

  /** The run finished: one more read decides the ids still missing, for the rest of the run. */
  runEnded(): void {
    this.ended = true;
    this.missing.clear();
  }

  private startRead(scope: NameScope): Promise<boolean> {
    const current = this.reading.get(scope);
    // A read that started before the run finished does not decide what is missing after it.
    if (current && (current.afterEnd || !this.ended)) return current.p;
    const afterEnd = this.ended;
    const p: Promise<boolean> = this.read(scope)
      .then((view) => {
        if (!view) return false;
        for (const [k, v] of displayNamesOf(view.citations?.by_key ?? {})) {
          this.names.set(k, v);
          this.missing.delete(k);
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (this.reading.get(scope)?.p === p) this.reading.delete(scope);
      });
    this.reading.set(scope, { p, afterEnd });
    return p;
  }
}
