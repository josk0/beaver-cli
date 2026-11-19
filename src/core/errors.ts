export type ErrorCode =
  | 'usage' | 'zotero_unreachable' | 'beaver_unavailable' | 'not_authenticated' | 'no_window'
  | 'busy_run' | 'busy_draft' | 'busy_attachments' | 'busy_cards' | 'thread_busy' | 'thread_conflict'
  | 'thread_not_found' | 'thread_other_instance'
  | 'send_failed' | 'send_unknown' | 'library_excluded'
  | 'run_error' | 'timeout' | 'stopped' | 'unsupported_pause' | 'account_changed' | 'library_access_changed'
  | 'protocol' | 'run_not_found' | 'action_not_found' | 'action_not_pending' | 'use_approve' | 'duplicate_run'
  | 'window_changed';

/** Process exit codes. Success is 0; an unexpected crash is 1. Several codes share an exit code. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  usage: 2,
  zotero_unreachable: 10,
  beaver_unavailable: 11,
  not_authenticated: 11,
  no_window: 12,
  busy_run: 13,
  busy_draft: 13,
  busy_attachments: 13,
  busy_cards: 13,
  thread_busy: 13,
  thread_conflict: 13,
  thread_not_found: 14,
  thread_other_instance: 14,
  send_failed: 15,
  send_unknown: 15,
  library_excluded: 15,
  run_error: 16,
  timeout: 17,
  stopped: 18,
  unsupported_pause: 19,
  account_changed: 20,
  library_access_changed: 20,
  protocol: 21,
  run_not_found: 21,
  action_not_found: 21,
  action_not_pending: 21,
  use_approve: 21,
  duplicate_run: 21,
  window_changed: 22,
};

/** What it means when Zotero answers but serves no chat routes. */
export const ROUTES_OFF_MESSAGE = "Beaver's terminal access is switched off, or this Beaver build does not have it.";
/** The next step when Zotero answers but serves no chat routes. */
export const ROUTES_OFF_STEP =
  "In Zotero, open Beaver's settings, go to Advanced and switch on 'Terminal and script access'; if that row is missing, the installed Beaver build does not include it.";
/** What it means when Beaver answers 401. */
export const SIGNED_OUT_MESSAGE = 'Beaver is signed out in Zotero.';

/** One sentence telling the person what to do about the error. */
export function nextStepFor(code: ErrorCode, ctx: { port: number }): string {
  switch (code) {
    case 'usage':
      return 'Run `beaver --help` to see the options.';
    case 'zotero_unreachable':
      return `Start Zotero on this computer (if it is running and listens on a port other than ${ctx.port}, pass that with --port).`;
    case 'beaver_unavailable':
      return ROUTES_OFF_STEP;
    case 'not_authenticated':
      return 'Sign in to Beaver in the Zotero window.';
    case 'no_window':
      return 'Open a Zotero window, or run `beaver windows` and pass --window <id>.';
    case 'busy_run':
      return 'Beaver is responding in the Zotero window; wait for it to finish or stop it there, then try again.';
    case 'busy_draft':
      return 'A message is being written in the Zotero window; send or clear it there, then try again.';
    case 'busy_attachments':
      return 'Items are staged in the Zotero window; send or remove them there, then try again.';
    case 'busy_cards':
      return 'A response in the Zotero window waits for answers there; answer them, then try again.';
    case 'thread_busy':
      return 'The chat could not be opened; it may be responding elsewhere. Try again in a moment.';
    case 'thread_conflict':
      return 'The chat changed elsewhere; open it in the Zotero window to refresh it, then try again.';
    case 'thread_not_found':
      return 'Check the chat id (`beaver threads` lists them); it must belong to the signed-in account. Start a new chat by leaving out -r.';
    case 'thread_other_instance':
      return 'This chat belongs to another Zotero account or database; open it there, or start a new chat.';
    case 'send_failed':
      return 'Nothing was sent; check the message and try again.';
    case 'send_unknown':
      return 'The message may not have been sent, or may still start in Zotero after this command has exited: check the Zotero window (stop the run there if it started) before sending it again.';
    case 'library_excluded':
      return 'The change is in a library excluded in Beaver Preferences; include the library there first.';
    case 'run_error':
      return 'The run failed; try again, or look at the chat in the Zotero window.';
    case 'timeout':
      return 'The command tried to stop the run; check `warnings`. Raise --timeout, or ask a narrower question.';
    case 'stopped':
      return 'The command tried to stop the run; check `warnings`. Ask again to retry.';
    case 'unsupported_pause':
      return 'The run needed an answer this command cannot give; continue the chat in the Zotero window.';
    case 'account_changed':
      return 'The Beaver account changed during the call; check that you are signed in in Zotero, then try again.';
    case 'library_access_changed':
      return "The library exclusions in Beaver's settings changed during the call; check them in Beaver Preferences, then try again.";
    case 'protocol':
    case 'run_not_found':
    case 'duplicate_run':
      return 'Beaver answered in a way this command does not understand; check the chat in the Zotero window, and that Zotero runs a compatible Beaver build.';
    case 'action_not_found':
      return 'Check the change id and the chat id; `apply_command` in the JSON output names both.';
    case 'action_not_pending':
      return 'The change was applied already, or is being applied; check its card in the Zotero window.';
    case 'use_approve':
      return 'The run still waits on this change; answer it where the run is shown (the Zotero window, or the session that started it).';
    case 'window_changed':
      return 'The Zotero window shows another chat. Continue with -r <chat id> when the window is free.';
  }
}

export class BeaverError extends Error {
  code: ErrorCode;
  nextStep: string;
  detail?: unknown;
  /**
   * Set by the client on transport failures: true when the request may have reached Zotero (a
   * timeout or a reset connection), false when it certainly did not (connection refused).
   */
  maybeSent?: boolean;
  /** The code Beaver's answer carried (`{ok:false, code}`), when it had one. */
  serverCode?: string;

  constructor(code: ErrorCode, message: string, ctx: { port: number; nextStep?: string }, detail?: unknown) {
    super(message);
    this.name = 'BeaverError';
    this.code = code;
    this.nextStep = ctx.nextStep ?? nextStepFor(code, ctx);
    this.detail = detail;
  }
}
