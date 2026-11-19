import { PassThrough } from 'node:stream';
import type { CliIO } from '../../src/cli.js';
import { fixture, type Frame, type SimRun } from './fakeBeaver.js';

export const T = '10000000-0000-4000-8000-000000000001';
export const OTHER = '10000000-0000-4000-8000-000000000009';
export const HOLM = 'u-PVX9VYC4';
/** The answer of the run-a fixture, as the command renders it. */
export const HOLM_ANSWER =
  'Holm’s (2023) “The Fairness in Algorithmic Fairness” examines what fairness means in algorithmic decision-making and how competing fairness criteria can be understood. (Holm 2023)';

/** `thread` for one run: the live fixture of run a, for whichever chat was asked. */
export const holmThread = (b: { thread_id: string; run_id?: string }) => ({
  ...fixture('thread-run-a'),
  thread_id: b.thread_id,
  run_ids: b.run_id ? [b.run_id] : fixture('thread-run-a').run_ids,
});

/** A run that shows `texts` in successive polls, then completes, answering with the Holm fixture. */
export function answeredRun(texts: string[] = ['I’ll find a relevant paper.'], over: Partial<SimRun> = {}): SimRun {
  const last = texts[texts.length - 1] ?? '';
  return {
    frames: [...texts.map((text): Frame => ({ state: 'running', text })), { state: 'completed', text: last, final_text: last }],
    thread: holmThread,
    ...over,
  };
}

/** A run that never ends by itself. */
export function endlessRun(text = 'Partial <citation id="u-PVX9VYC4"/> answer', over: Partial<SimRun> = {}): SimRun {
  return { frames: [{ state: 'running', text }], ...over };
}

/** A question with one item and three options; `allow` adds multiple choice or an answer of one's own. */
export const questionOf = (toolcallId = 'tq', allow: { allow_multiple?: boolean; allow_custom?: boolean } = {}) => ({
  toolcall_id: toolcallId,
  question_id: `qid-${toolcallId}`,
  items: [
    {
      id: 'q0',
      header: 'Scope',
      question: 'Which papers should I compare?',
      options: [
        { id: 'q0-o0', label: 'The newest', description: 'since 2020' },
        { id: 'q0-o1', label: 'The most cited' },
        { id: 'q0-o2', label: 'All of them' },
      ],
      ...allow,
    },
  ],
});

/** A pending approval of `action`. */
export const approvalFrame = (actionId = 'act1', over: Record<string, unknown> = {}): Frame => ({
  state: 'awaiting_input',
  approvals: [
    {
      action_id: actionId,
      toolcall_id: 'tc1',
      action_type: 'edit_note',
      proposed_data: { library_ref: 'u', zotero_key: 'NOTE1234', operation: 'str_replace', old_string: '<p>old</p>', new_string: '<p>new</p>' },
      current_value: null,
    },
  ],
  ...over,
});

export interface Captured {
  io: CliIO;
  stdout: () => string;
  stderr: () => string;
}

export function capture(over: Partial<CliIO> & { stdinText?: string } = {}): Captured {
  let out = '';
  let err = '';
  const stdin = over.stdin ?? new PassThrough();
  if (over.stdinText !== undefined && stdin instanceof PassThrough) stdin.end(over.stdinText);
  const { stdinText: _unused, ...rest } = over;
  const io: CliIO = {
    stdin,
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env: {},
    ...rest,
  };
  return { io, stdout: () => out, stderr: () => err };
}
