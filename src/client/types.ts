// Shapes of the answers of Beaver's /beaver/chat/* routes (interface version 1). Fields the command
// does not use are omitted.

export interface WindowInfo {
  id: string;
  kind: 'main' | 'standalone';
  status: string;
}

export interface Info {
  interface_version: number;
  plugin_version: string;
  windows: WindowInfo[];
  default_window_id: string | null;
}

export interface ThreadRow {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  awaiting_input: unknown;
}

export interface ThreadPage {
  threads: ThreadRow[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface OpenResult {
  thread_id: string | null;
  switched: boolean;
}

export interface ItemRef {
  library_ref?: string;
  library_id?: number;
  zotero_key: string;
}

/** `status`: `not_found`, `library_unavailable` or `library_excluded`. */
export type UnresolvedItem = ItemRef & { status: string };

export interface SendResult {
  thread_id: string | null;
  run_id: string;
  started: boolean;
  unresolved_items: UnresolvedItem[];
}

export type RunState =
  | 'starting'
  | 'not_started'
  | 'running'
  | 'awaiting_input'
  | 'finalizing'
  | 'completed'
  | 'error'
  | 'canceled'
  | 'parked';

export interface ToolCall {
  id: string;
  name: string;
  /** A readable label, e.g. `Item search: "fairness"`. */
  label?: string | null;
  returned: boolean;
}

export interface Approval {
  action_id: string;
  toolcall_id: string;
  action_type: string;
  proposed_data: unknown;
  current_value: unknown;
  excluded?: boolean;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string | null;
}

/** One question of a request Beaver asks during a run. */
export interface QuestionItem {
  id: string;
  /** A very short label for the question. */
  header?: string | null;
  question: string;
  options: QuestionOption[];
  allow_multiple?: boolean;
  /** Whether an answer of one's own (free text) is offered. */
  allow_custom?: boolean;
}

export interface Question {
  toolcall_id: string;
  question_id: string;
  items: QuestionItem[];
}

export interface QuestionAnswer {
  item_id: string;
  selected_option_ids: string[];
  custom_text?: string;
}

export interface CreditConfirmation {
  confirmation_id: string;
  title: string;
  message: string;
  pending_credits: number;
}

export interface RunAction {
  id: string;
  action_type: string;
  status: string;
  toolcall_id: string | null;
}

export interface RunStatus {
  thread_id: string | null;
  thread_name: string | null;
  /** The run asked about, or the newest run that continues it (a resume). */
  run_id: string;
  state: RunState;
  is_active: boolean;
  error: { type: string; message: string; is_retryable: boolean | null; is_resumable: boolean | null } | null;
  text: string;
  final_text: string;
  tool_calls: ToolCall[];
  approvals: Approval[];
  questions: Question[];
  credit_confirmations: CreditConfirmation[];
  actions: RunAction[];
}

export type ApproveBody =
  | { kind: 'approval'; action_id: string; approved: boolean; instructions?: string }
  | { kind: 'question'; toolcall_id: string; cancelled: true }
  | { kind: 'question'; toolcall_id: string; answers: QuestionAnswer[] }
  | { kind: 'credits'; confirmation_id: string; approved: boolean };

export interface StopResult {
  stopped: boolean;
  run_id: string | null;
}

export interface ApplyResult {
  applied: string[];
  failed: Array<{ action_id: string; error: unknown }>;
}

export interface CitationRef {
  kind: 'zotero';
  library_id: number;
  zotero_key: string;
  library_ref: string;
  loc?: unknown;
}

export interface Citation {
  citation_id: string;
  requested_ref?: CitationRef;
  resolved_ref?: CitationRef;
  citation_type?: string;
  display_name?: string;
  formatted_citation?: string;
  /** 1-based physical pages. */
  pages?: number[];
  /** 0-based page index -> printed page label, e.g. {"1": "266"}. */
  page_labels?: Record<string, string>;
  /** The parent item of a cited attachment (citation_type "attachment"). */
  parent_ref?: CitationRef;
  raw_tag?: string;
  invalid?: boolean;
  /** The citation's library is excluded now: everything but the id is left out. */
  excluded?: boolean;
}

export type ThreadBlock =
  | { type: 'user'; text: string }
  | { type: 'markdown'; markdown: string }
  | { type: 'activity'; calls: string[] }
  | { type: 'note'; title: string; markdown: string };

export interface ThreadView {
  thread_id: string;
  title: string;
  blocks: ThreadBlock[];
  citations: { by_key: Record<string, Citation> };
}
