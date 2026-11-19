import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../../src/client/types.js';
import { DECLINE_INSTRUCTION, scriptPolicy } from '../../src/core/policy.js';
import { pauseKey, pausesOf } from '../../src/core/settle.js';
import { questionOf } from '../helpers/cli.js';

const status = (over: Partial<RunStatus>): RunStatus => ({
  thread_id: 't',
  thread_name: null,
  run_id: 'r',
  state: 'awaiting_input',
  is_active: true,
  error: null,
  text: '',
  final_text: '',
  tool_calls: [],
  approvals: [],
  questions: [],
  credit_confirmations: [],
  actions: [],
  ...over,
});

describe('pausesOf', () => {
  it('lists approvals with their proposed change, questions and credit confirmations, in that order', () => {
    const p = pausesOf(
      status({
        approvals: [{ action_id: 'a1', toolcall_id: 't1', action_type: 'edit_note', proposed_data: { x: 1 }, current_value: 'old' }],
        questions: [questionOf('tq')],
        credit_confirmations: [{ confirmation_id: 'c1', title: 'T', message: 'M', pending_credits: 3 }],
      }),
    );
    expect(p).toEqual([
      { kind: 'approval', actionId: 'a1', actionType: 'edit_note', proposedData: { x: 1 }, currentValue: 'old', excluded: false },
      { kind: 'question', toolcallId: 'tq', items: questionOf('tq').items },
      { kind: 'credits', confirmationId: 'c1', title: 'T', message: 'M', pendingCredits: 3 },
    ]);
    expect(p.map(pauseKey)).toEqual(['approval:a1', 'question:tq', 'credits:c1']);
  });

  it('an approval in an excluded library carries no data and says so', () => {
    const [p] = pausesOf(status({ approvals: [{ action_id: 'a', toolcall_id: 't', action_type: 'edit_note', proposed_data: null, current_value: null, excluded: true }] }));
    expect(p).toMatchObject({ kind: 'approval', excluded: true, proposedData: null });
  });

  it('nothing listed is no pause', () => {
    expect(pausesOf(status({}))).toEqual([]);
  });
});

describe('scriptPolicy', () => {
  it('declines approvals with the instruction, cancels questions, declines credits, stops on the rest', async () => {
    const sig = new AbortController().signal;
    expect(await scriptPolicy({ kind: 'approval', actionId: 'a', actionType: 'x', proposedData: null, currentValue: null, excluded: false }, sig)).toEqual({
      action: 'decline',
      instructions: DECLINE_INSTRUCTION,
    });
    expect(await scriptPolicy({ kind: 'question', toolcallId: 'q', items: [] }, sig)).toEqual({ action: 'cancel_question' });
    expect(await scriptPolicy({ kind: 'credits', confirmationId: 'c', title: '', message: '', pendingCredits: 1 }, sig)).toEqual({ action: 'decline_credits' });
    expect(await scriptPolicy({ kind: 'unsupported', what: 'parked' }, sig)).toEqual({ action: 'stop' });
  });
});
