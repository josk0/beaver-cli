import type { QuestionItem, RunState, RunStatus } from '../client/types.js';

/** Something a paused run waits for. */
export type Pause =
  | { kind: 'approval'; actionId: string; actionType: string; proposedData: unknown; currentValue: unknown; excluded: boolean }
  | { kind: 'question'; toolcallId: string; items: QuestionItem[] }
  | { kind: 'credits'; confirmationId: string; title: string; message: string; pendingCredits: number }
  | { kind: 'unsupported'; what: 'parked' | 'unlisted' };

/** States after which the run does nothing more. */
export const FINAL: ReadonlySet<RunState> = new Set(['completed', 'error', 'canceled']);

/** What the run waits on, as `status` lists it; empty unless the run is the active run. */
export function pausesOf(s: RunStatus): Pause[] {
  const pauses: Pause[] = [];
  for (const a of s.approvals ?? []) {
    pauses.push({
      kind: 'approval',
      actionId: a.action_id,
      actionType: a.action_type,
      proposedData: a.proposed_data ?? null,
      currentValue: a.current_value ?? null,
      excluded: a.excluded === true,
    });
  }
  for (const q of s.questions ?? []) pauses.push({ kind: 'question', toolcallId: q.toolcall_id, items: Array.isArray(q.items) ? q.items : [] });
  for (const c of s.credit_confirmations ?? []) {
    pauses.push({
      kind: 'credits',
      confirmationId: c.confirmation_id,
      title: c.title,
      message: c.message,
      pendingCredits: c.pending_credits,
    });
  }
  return pauses;
}

export function pauseKey(p: Pause): string {
  switch (p.kind) {
    case 'approval':
      return `approval:${p.actionId}`;
    case 'question':
      return `question:${p.toolcallId}`;
    case 'credits':
      return `credits:${p.confirmationId}`;
    case 'unsupported':
      return `unsupported:${p.what}`;
  }
}
