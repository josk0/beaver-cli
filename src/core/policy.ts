import type { QuestionAnswer } from '../client/types.js';
import type { Pause } from './settle.js';

export type PauseDecision =
  | { action: 'approve' }
  | { action: 'decline'; instructions?: string }
  | { action: 'cancel_question' }
  | { action: 'answer_question'; answers: QuestionAnswer[] }
  | { action: 'confirm_credits' }
  | { action: 'decline_credits' }
  | { action: 'stop' };

/**
 * Decides what to do about one pause of the run. The session aborts `signal` when it no longer needs
 * the decision: with reason PAUSE_ANSWERED_ELSEWHERE when the pause was answered in the Zotero window,
 * otherwise at the deadline, on cancel, or once a decision arrived.
 */
export type PausePolicy = (pause: Pause, signal: AbortSignal) => Promise<PauseDecision>;

/** Abort reason of a policy's signal: the person answered the pause in the Zotero window. */
export const PAUSE_ANSWERED_ELSEWHERE = 'pause_answered_elsewhere';

export const DECLINE_INSTRUCTION =
  'No one is available to approve changes in this session. Do not try again. Put the content in your answer instead.';

/** Script mode: nobody can be asked, so decline or cancel everything and stop on what cannot be answered. */
export const scriptPolicy: PausePolicy = async (pause) => {
  switch (pause.kind) {
    case 'approval':
      return { action: 'decline', instructions: DECLINE_INSTRUCTION };
    case 'question':
      return { action: 'cancel_question' };
    case 'credits':
      return { action: 'decline_credits' };
    case 'unsupported':
      return { action: 'stop' };
  }
};
