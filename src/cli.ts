import { Command, CommanderError } from 'commander';
import { BeaverError, EXIT_CODES, nextStepFor } from './core/errors.js';
import { emptyAskResult, errorInfo, writeError, writeJson } from './modes/output.js';
import { runInteractive } from './modes/interactive.js';
import { runPrint } from './modes/print.js';
import { runStatus, runWindows } from './modes/status.js';
import { runApply, runThreads } from './modes/chats.js';
import { isChatId, notAChatId, type AskOptions } from './core/session.js';

export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** `columns` is the terminal width, when stdout is a terminal. */
  stdout: { write(s: string): unknown; isTTY?: boolean; columns?: number };
  stderr: { write(s: string): unknown; isTTY?: boolean };
  env: Record<string, string | undefined>;
  /** Aborts script mode (-p): the command tries to stop its run and reports the partial answer. */
  signal?: AbortSignal;
  /**
   * Interactive mode: subscribes to Ctrl-C and returns the unsubscribe function. The real streams
   * are wired in main.ts; tests drive it directly.
   */
  onInterrupt?: (handler: () => void) => () => void;
  /**
   * Interactive mode: ends the process at once with this code (a second Ctrl-C while a stop is in
   * progress). When absent, runInteractive returns the code instead.
   */
  exit?: (code: number) => void;
}

/** Test hooks; not part of the command line. */
export interface CliTuning {
  pollMs?: number;
}

const DEFAULT_PORT = 23119;

const EXIT_TABLE: Array<[number, string]> = [
  [0, 'success (JSON status "ok")'],
  [1, 'unexpected failure of the command itself'],
  [EXIT_CODES.usage, 'usage: wrong or missing arguments'],
  [EXIT_CODES.zotero_unreachable, 'zotero_unreachable: nothing answers on the port (Zotero not running, or another port)'],
  [EXIT_CODES.beaver_unavailable, "beaver_unavailable: Zotero answers but serves no chat routes ('Terminal and script access' is off, or the build has no such setting); not_authenticated: Beaver is signed out"],
  [EXIT_CODES.no_window, 'no_window: no (such) Zotero window runs Beaver'],
  [EXIT_CODES.busy_run, 'busy_run, busy_draft, busy_attachments, busy_cards, thread_busy, thread_conflict: the window is in use; nothing was sent'],
  [EXIT_CODES.thread_not_found, 'thread_not_found, thread_other_instance: the chat given with -r (or -c) could not be opened'],
  [EXIT_CODES.send_failed, 'send_failed: nothing was sent; send_unknown: the message may not have been sent (check the window, do not resend blindly); library_excluded'],
  [EXIT_CODES.run_error, 'run_error: the run failed or needed a credit confirmation'],
  [EXIT_CODES.timeout, 'timeout: no answer within --timeout; the command tries to stop its run (check warnings), partial answer returned'],
  [EXIT_CODES.stopped, 'stopped: cancelled (Ctrl-C); the command tries to stop its run (check warnings), partial answer returned'],
  [EXIT_CODES.unsupported_pause, 'unsupported_pause: the run needed an answer this command cannot give'],
  [EXIT_CODES.account_changed, "account_changed: the Beaver account changed during the call; library_access_changed: the library exclusions in Beaver's settings changed"],
  [EXIT_CODES.protocol, 'protocol (also run_not_found, action_not_found, action_not_pending, use_approve, duplicate_run): Beaver answered in a way this command did not expect'],
  [EXIT_CODES.window_changed, 'window_changed: the window switched to another chat during the call; the run continues there'],
];

function helpAfter(): string {
  const codes = EXIT_TABLE.map(([n, d]) => `  ${String(n).padStart(2)}  ${d}`).join('\n');
  return `
Behaviour
  This command drives the chat of a Zotero window open on this machine: Zotero must be running
  with Beaver signed in, and 'Terminal and script access' switched on in Beaver's advanced
  settings. Messages and answers also appear in that window. Beaver refuses a message (exit 13,
  nothing sent) while the window is in use: a response running, a draft typed or items staged
  when the chat must change, cards waiting for answers. A message carries only the items given
  with --item, never the window's draft, staged items, open PDF or open note.
  Script mode (-p) never prompts. Changes that Beaver asks about are declined, with an
  instruction to put the content in the answer, and listed in declined_actions with the command
  that applies them later. Changes that Beaver applies without asking (by default, creating a
  note) are applied and listed in applied_actions. If the run pauses on something script mode
  cannot answer, the command tries to stop it. After --timeout or Ctrl-C the command tries to
  stop its run (check warnings) and reports the partial answer.
  Each call runs Beaver's agent and uses the account's Beaver credits.

Examples
  beaver                                       interactive chat in a new chat (type /help)
  beaver -c                                    interactive, in the most recently updated chat
  beaver -p --json "What do my papers say about algorithmic fairness?"   one JSON object
  beaver -p --json -r <thread-id> "And the newer ones?"     follow up in that chat
  echo "Explain this paper" | beaver -p --json --item ABCD1234     prompt on stdin, attached item
  beaver threads fairness                      saved chats whose name matches "fairness"
  beaver apply <action-id> -r <thread-id>      apply a change that was declined
  beaver status --json                         is Zotero reachable, are the chat routes on?
  -p takes the prompt as its value or as the last argument; --json may come before or after it.

For programs and AI agents
  Check first: beaver status --json; ready when reachable && beaver_available && error == null.
  Success: -p results have status == "ok"; status, threads, windows and apply have error == null.
  With --json, stdout is always exactly one JSON object on one line and stderr stays empty.
  Continue a chat with -r <thread_id> from the earlier result; -c takes the most recently updated
  chat of the account, which may be another session's, so prefer -r.
  Never run an apply_command without asking the user: applying changes the library.

JSON output (-p --json): exactly one object on one stdout line, also on failure (--help
  prints this help text instead)
  {"schema_version":1, "status":"ok"|"error", "thread_id", "thread_name", "run_id",
   "sent_run_id", "answer", "references",
   "sources":[{"n","display_name","reference","item_key","library_ref","zotero_uri","pages"?}],
   "applied_actions":[{"id","type","status"}],
   "declined_actions":[{"id","type","status","apply_command"}],
   "unresolved_items":[{"library_ref"?,"item_key","status"}],
   "warnings":[string], "error": null | {"code","message","next_step"}}
  - answer: Markdown. Citations appear inline as (<display_name>[, pages][; ...]); each
    display_name equals one sources[].display_name. On error: the partial text, if any.
  - sources: the sources of THIS answer; n is the order in this answer, not stable across a chat;
    pages: printed page numbers cited, absent when the source was cited as a whole; library_ref
    is "u" (personal library) or "g<groupID>" (group); library_ref + item_key identify an item;
    zotero_uri opens it. references: the same sources as one formatted text block.
  - thread_id: use it with -r to continue the chat; null unless Beaver confirmed the chat.
  - run_id, sent_run_id: for logs (they differ when Beaver resumed the run under a new id).
  - applied_actions, declined_actions: changes of this run; type is Beaver's action type (e.g.
    create_note, edit_note, create_item); status is pending, applied, rejected, undone, error,
    or unknown. apply_command applies a declined change (null while the chat has no id).
  - unresolved_items: items given with --item that were not sent; status is not_found,
    library_unavailable, library_excluded or rejected.
  - warnings: sentences to show the user.
  beaver threads --json: {"schema_version":1, "threads":[{"id","name","created_at","updated_at",
   "pinned"}], "has_more", "next_cursor", "error"}; success: error == null; next page: --after
   <next_cursor>.
  beaver apply --json: {"schema_version":1, "thread_id", "applied":[id], "failed":[{"action_id",
   "error"}], "error"}; success: error == null (applied lists what was applied).
  beaver status --json: {"schema_version":1, "reachable", "beaver_available", "plugin_version",
   "interface_version", "default_window_id", "windows", "error"}; ready: reachable &&
   beaver_available && error == null.
  beaver windows --json: {"schema_version":1, "windows":[{"id","kind","status"}],
   "default_window_id", "error"}; success: error == null.
  Text mode (no --json): the answer, then "Sources:" and the list, on stdout; the line
  "Chat: <thread_id>", applied and declined changes, warnings and errors on stderr.

Exit codes
${codes}
`;
}

function fullIO(io: Partial<CliIO>): CliIO {
  return {
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    signal: io.signal,
    onInterrupt: io.onInterrupt,
    exit: io.exit,
  };
}

/** Options whose next argv entry is their value, so it is not mistaken for a command name. */
const VALUE_FLAGS = new Set(['-p', '--print', '-r', '--resume', '--item', '--port', '--window', '--timeout', '--limit', '--after']);

type CommandKind = 'status' | 'windows' | 'threads' | 'apply' | 'ask';
const SUBCOMMANDS = new Set<string>(['status', 'windows', 'threads', 'apply']);

/** Which output shape an argument error should take: that of a subcommand, or the ask. */
function guessCommand(argv: string[]): CommandKind {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break;
    if (VALUE_FLAGS.has(argv[i - 1] ?? '')) continue;
    if (SUBCOMMANDS.has(argv[i])) return argv[i] as CommandKind;
    if (!argv[i].startsWith('-')) break;
  }
  return 'ask';
}

interface RawOptions {
  print?: string | true;
  json?: boolean;
  continue?: boolean;
  resume?: string;
  item?: string[];
  timeout?: string;
  port?: string;
  window?: string;
}

function usage(message: string, port = DEFAULT_PORT): BeaverError {
  return new BeaverError('usage', message, { port });
}

function parsePort(raw: string | undefined, env: CliIO['env']): number {
  const text = raw ?? env.BEAVER_PORT;
  if (text === undefined || text === '') return DEFAULT_PORT;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw usage(`Invalid port: ${text}`);
  return n;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 600_000;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) throw usage(`Invalid --timeout: ${raw} (seconds, greater than 0)`);
  return Math.round(secs * 1000);
}

/** "KEY" (personal library) or "g<groupID>:KEY". */
function parseItem(raw: string): { library_ref: string; zotero_key: string } {
  const m = /^(?:(g\d+):)?([A-Za-z0-9]+)$/.exec(raw);
  if (!m) throw usage(`Invalid --item: ${raw} (use KEY or g<groupID>:KEY)`);
  return { library_ref: m[1] ?? 'u', zotero_key: m[2] };
}

export async function runCli(argv: string[], ioIn: Partial<CliIO> = {}, tuning: CliTuning = {}): Promise<number> {
  const io = fullIO(ioIn);
  const json = argv.includes('--json');
  let exit: number | undefined;

  /** Runs one command body: every failure becomes the one error output of that command. */
  const guarded = async (kind: CommandKind, body: () => Promise<number>): Promise<void> => {
    try {
      exit = await body();
    } catch (e) {
      exit = reportFailure(kind, e);
    }
  };

  const reportFailure = (kind: CommandKind, e: unknown): number => {
    const info = errorInfo(e);
    if (json) {
      if (kind === 'status') {
        writeJson(io, {
          reachable: false,
          beaver_available: false,
          plugin_version: null,
          interface_version: null,
          default_window_id: null,
          windows: 0,
          error: info,
        });
      } else if (kind === 'windows') {
        writeJson(io, { windows: [], default_window_id: null, error: info });
      } else if (kind === 'threads') {
        writeJson(io, { threads: [], has_more: false, next_cursor: null, error: info });
      } else if (kind === 'apply') {
        writeJson(io, { thread_id: null, applied: [], failed: [], error: info });
      } else {
        writeJson(io, { ...emptyAskResult(info) });
      }
    } else {
      writeError(io, info);
    }
    return EXIT_CODES[info.code];
  };

  const program = new Command();
  program
    .name('beaver')
    .description(
      "Chat with Beaver, the research assistant of the Zotero plugin, from a terminal. Interactive without -p; with -p one question gives one complete answer (for scripts and AI agents; add --json). It uses the chat of the open Zotero window, so the answer also appears there.",
    )
    .argument('[prompt...]', 'the prompt, as an alternative to the argument of -p')
    .option('-p, --print [prompt]', 'one answer, then exit; the prompt is the argument, or stdin when there is none (stdin is not read when an argument is given)')
    .option('--json', 'print one JSON object (schema below) instead of text; also for errors')
    .option('-c, --continue', 'continue the most recently updated saved chat')
    .option('-r, --resume <thread-id>', 'continue a saved chat by its id (`beaver threads` lists them); with apply, the chat of the change')
    .option('--item <key>', 'attach a library item, repeatable: "KEY" (personal library) or "g<groupID>:KEY" (-p only)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--timeout <seconds>', 'give up on a run after this long and stop it (default 600)')
    .option('--port <n>', 'port of the Zotero server (default $BEAVER_PORT, else 23119)')
    .option('--window <id>', 'target window (ids from `beaver windows`)')
    .addHelpText('after', helpAfter())
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
      // With --json the error text goes into the JSON object instead.
      outputError: (s, write) => {
        if (!json) write(s);
      },
    });

  program.command('windows').description('list the Zotero windows that run Beaver');
  program.command('status').description('is Zotero reachable, are the chat routes on, which windows run Beaver');
  program
    .command('threads')
    .argument('[query...]', 'words the chat names must match')
    .option('--limit <n>', 'how many chats to list, 1 to 50 (default 20)')
    .option('--after <cursor>', 'the next page: the next_cursor of the previous listing')
    .description('list saved chats, most recently updated first');
  program.command('apply').argument('<action-id>', 'the change, from declined_actions').description('apply a declined or undecided change of the chat given with -r');

  const common = (opts: RawOptions) => ({ port: parsePort(opts.port, io.env), windowId: opts.window });

  // Handlers are attached after configuration so the subcommands share the root's options.
  program.commands.find((c) => c.name() === 'windows')!.action(async () => {
    await guarded('windows', async () => runWindows({ port: common(program.opts()).port, json }, io));
  });
  program.commands.find((c) => c.name() === 'status')!.action(async () => {
    await guarded('status', async () => {
      return runStatus({ port: common(program.opts()).port, json }, io);
    });
  });
  program.commands.find((c) => c.name() === 'threads')!.action(async (words: string[], sub: { limit?: string; after?: string }) => {
    await guarded('threads', async () => {
      const query = words.join(' ').trim();
      const limit = sub.limit === undefined ? undefined : Number(sub.limit);
      return runThreads({ port: common(program.opts()).port, query: query || undefined, limit, after: sub.after, json }, io);
    });
  });
  program.commands.find((c) => c.name() === 'apply')!.action(async (actionId: string) => {
    await guarded('apply', async () => {
      const opts = program.opts<RawOptions>();
      const { port, windowId } = common(opts);
      if (opts.resume === undefined || opts.resume.trim() === '') throw usage('apply needs the chat of the change: -r <thread-id>.', port);
      if (!isChatId(opts.resume)) throw notAChatId(opts.resume, port);
      return runApply({ port, windowId, threadId: opts.resume, actionId, json }, io);
    });
  });

  program.action(async (words: string[]) => {
    await guarded('ask', async () => {
      const opts = program.opts<RawOptions>();
      const { port, windowId } = common(opts);
      if (opts.continue && opts.resume !== undefined) throw usage('Use either -c or -r, not both.', port);
      if (opts.resume !== undefined && opts.resume.trim() === '') throw usage('-r needs a chat id.', port);
      if (opts.resume !== undefined && !isChatId(opts.resume)) throw notAChatId(opts.resume, port);
      const timeoutMs = parseTimeoutMs(opts.timeout);
      const items = (opts.item ?? []).map(parseItem);
      const thread: AskOptions['thread'] =
        opts.resume !== undefined ? { id: opts.resume } : opts.continue ? { latest: true } : { new: true };

      if (opts.print === undefined) {
        if (words.length > 0) throw usage(`Unexpected argument "${words[0]}". Use -p to send a prompt.`, port);
        if (json) throw usage('--json needs -p, or one of status, windows, threads, apply.', port);
        if (items.length > 0) throw usage('--item needs -p.', port);
        return runInteractive({ port, windowId, thread, timeoutMs, pollMs: tuning.pollMs }, io);
      }
      const prompt = typeof opts.print === 'string' ? [opts.print, ...words].join(' ') : words.length > 0 ? words.join(' ') : undefined;
      return runPrint({ prompt, json, thread, items, timeoutMs, port, windowId, pollMs: tuning.pollMs }, io);
    });
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.help' || e.code === 'commander.version') return 0;
      const message = e.message.replace(/^error:\s*/i, '');
      const err = new BeaverError('usage', message, { port: DEFAULT_PORT });
      if (!json) io.stderr.write(`Next: ${nextStepFor('usage', { port: DEFAULT_PORT })}\n`);
      else reportFailure(guessCommand(argv), err);
      return EXIT_CODES.usage;
    }
    return reportFailure(guessCommand(argv), e);
  }
  return exit ?? 0;
}

