import type { CliIO } from '../cli.js';
import { connect, type BeaverClient } from '../client/http.js';
import type { QuestionAnswer, ThreadRow } from '../client/types.js';
import { BeaverError, EXIT_CODES } from '../core/errors.js';
import { PAUSE_ANSWERED_ELSEWHERE, type PauseDecision, type PausePolicy } from '../core/policy.js';
import { DisplayNames } from '../core/displayNames.js';
import { formatSourceList } from '../core/result.js';
import { ChatSession, STOP_UNCONFIRMED, type AskOptions, type AskResult } from '../core/session.js';
import { errorInfo, formatAnswer, reportSideEffects, writeError } from './output.js';
import { AnswerRenderer, sgr, styleSources } from './render.js';
import { AnswerStream, Spinner } from './stream.js';
import { formatThreadList } from './chats.js';
import { PlainInput, TerminalInput, type LineInput } from './lineInput.js';
import { describeProposal } from './proposal.js';
import { formatQuestion, parseQuestionAnswer, questionPrompt } from './questions.js';
import { collectStatus, formatStatus } from './status.js';

export interface InteractiveOptions {
  port: number;
  windowId?: string;
  thread: AskOptions['thread'];
  timeoutMs: number;
  /** Poll interval; 300 ms when unset, so the answer shows up while it is written. */
  pollMs?: number;
}

const POLL_MS = 300;

const HELP = `Type a message and press Enter; end a line with \\ to continue on the next line. The answer appears while Beaver writes it.
On a terminal: the arrow keys edit the line and recall earlier messages, a pasted paragraph is one message, and Ctrl-C clears a typed line.
/help            this text
/new             the next message starts a new chat
/threads [text]  list saved chats, numbered (with text: those that match)
/resume <n|id>   continue a saved chat: its number in the last /threads list, or its id
/show            print the whole chat
/status          Zotero, Beaver and the chat this session is bound to
/stop            stop a run in this chat that was started in the Zotero window
/quit            leave (Ctrl-D also leaves; Ctrl-C stops a running answer, and leaves at an empty prompt)`;

/** From the last "> **User:**" line to the end, that line included. */
function lastExchange(body: string): string {
  const lines = body.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('> **User:**')) {
      at = i;
      break;
    }
  }
  return at < 0 ? '' : lines.slice(at).join('\n').trim();
}

/** Line-based chat loop. Returns the exit code; never throws. */
export async function runInteractive(opts: InteractiveOptions, rawIO: CliIO): Promise<number> {
  /** On a terminal: indented, wrapped, markdown-styled answers, a spinner, friendly tool lines. */
  const styled = rawIO.stdout.isTTY === true;
  const useColor = styled && !rawIO.env.NO_COLOR;
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
  /** The "Thinking…" line of the message being sent; any output clears it first. */
  let spinner: Spinner | null = null;
  const stopSpinner = () => spinner?.stop();
  const io: CliIO = {
    ...rawIO,
    stdout: {
      write: (s: string) => {
        spinner?.stop();
        return rawIO.stdout.write(s);
      },
      isTTY: rawIO.stdout.isTTY,
      columns: rawIO.stdout.columns,
    },
    stderr: {
      write: (s: string) => {
        spinner?.stop();
        return rawIO.stderr.write(s);
      },
      isTTY: rawIO.stderr.isTTY,
    },
  };
  const out = (s: string) => io.stdout.write(s);
  const width = () => Math.min(rawIO.stdout.columns || 80, 90);
  const sources = (r: AskResult) => (styled ? styleSources(formatSourceList(r.sources), { color: useColor, width: width() }) : `Sources:\n${formatSourceList(r.sources)}`);

  let client: BeaverClient;
  try {
    client = (await connect({ port: opts.port, windowId: opts.windowId })).client;
  } catch (e) {
    const info = errorInfo(e, opts.port);
    writeError(io, info);
    return EXIT_CODES[info.code];
  }
  const session = new ChatSession(client, { port: opts.port });
  // Names of the sources the running answer cites, from Beaver's citations of the run or the chat.
  const names = new DisplayNames(async (scope) => {
    const threadId = session.threadId;
    const runId = session.runId;
    if (!threadId || !runId) return null;
    return client.thread(scope === 'run' ? { threadId, runId } : { threadId });
  });
  /** The chats of the last /threads list, for /resume <n>. */
  let listed: ThreadRow[] = [];

  /** The title and the last exchange of the chat that was just opened. */
  const printTail = async (): Promise<void> => {
    if (session.threadId === null) return;
    const t = await session.transcript({ opened: true });
    const tail = lastExchange(t.body);
    if (t.title) out(`${dim(`Chat: ${t.title}`)}\n`);
    if (tail) out(`${tail}\n\n`);
  };

  // Start: attach to a chat; any failure ends the session at once.
  try {
    if ('id' in opts.thread) {
      await session.open(opts.thread);
      await printTail();
    } else if ('latest' in opts.thread) {
      let latest: string | null = null;
      try {
        latest = await session.latestThreadId();
      } catch (e) {
        if (!(e instanceof BeaverError && e.code === 'thread_not_found')) throw e;
        out('No saved chat yet; the next message starts a new chat.\n');
      }
      if (latest !== null) {
        await session.open({ id: latest });
        await printTail();
      }
    }
  } catch (e) {
    const info = errorInfo(e, opts.port);
    writeError(io, info);
    return EXIT_CODES[info.code];
  }

  // Line editing and history only when both ends are a terminal; otherwise lines are read as they come.
  // A dumb terminal cannot move the cursor: it gets the plain line reader.
  const editable = io.stdin.isTTY === true && rawIO.stdout.isTTY === true && io.env.TERM !== 'dumb';
  const terminal = editable ? new TerminalInput(io.stdin, rawIO.stdout) : null;
  const reader: LineInput = terminal ?? new PlainInput(io.stdin, out);
  let active: AbortController | null = null;
  let forceExit: (code: number) => void = () => {};
  const forced = new Promise<number>((resolve) => {
    forceExit = resolve;
  });
  const onCtrlC = () => {
    if (active?.signal.aborted) {
      spinner?.stop();
      // Second Ctrl-C while the stop is still in progress: leave without waiting for it.
      io.stderr.write('beaver: left without waiting for the stop; check the Zotero window.\n');
      forceExit(EXIT_CODES.stopped);
      io.exit?.(EXIT_CODES.stopped);
    } else if (active) active.abort();
    else reader.close(); // Ctrl-C at the prompt leaves
  };
  const unsubscribe = io.onInterrupt?.(onCtrlC);
  if (terminal) {
    // In raw mode Ctrl-C is a key, not a signal: readline reports it with the line typed so far.
    terminal.onInterrupt = (line) => {
      if (!active && line !== '') terminal.clearLine();
      else onCtrlC();
    };
  }

  const echoNewline = () => {
    if (!io.stdin.isTTY) out('\n');
  };

  /** A y/n question is answered only by input that arrives after it is shown. */
  const discardTypeahead = (): void => {
    const n = reader.discard();
    if (n > 0) out(`Discarded ${n} line(s) typed before this question.\n`);
  };

  /** One answer line after `prompt`; released (null) when the session no longer needs it. */
  const answerLine = async (prompt: string, signal: AbortSignal): Promise<string> => {
    const line = await reader.read({ prompt, signal });
    if (signal.aborted && signal.reason === PAUSE_ANSWERED_ELSEWHERE) out('\nAnswered in the Zotero window.\n');
    else echoNewline();
    return (line ?? '').trim();
  };

  /** The answer of the message being sent, while it streams. */
  let stream: AnswerStream | null = null;

  const policy: PausePolicy = async (pause, signal): Promise<PauseDecision> => {
    await stream?.settle(); // a question never starts in the middle of a line of the answer
    switch (pause.kind) {
      case 'approval': {
        out(
          `Beaver wants to make a change: ${pause.actionType}\n${describeProposal(pause, {
            color: useColor,
            width: styled ? width() : undefined,
            nameOf: (id) => names.known(id),
          })}\n`,
        );
        discardTypeahead();
        if (pause.excluded) {
          // Beaver cannot apply a change to an excluded library; declining is the only answer.
          await answerLine('It cannot be applied from here. Any answer declines it: ', signal);
          return { action: 'decline' };
        }
        const answer = await answerLine('Approve? [y]es / [n]o / or type an instruction to decline with: ', signal);
        if (/^y(es)?$/i.test(answer)) return { action: 'approve' };
        if (answer === '' || /^n(o)?$/i.test(answer)) return { action: 'decline' };
        return { action: 'decline', instructions: answer };
      }
      case 'credits': {
        out(`${pause.title}\n${pause.message}\nThis needs ${pause.pendingCredits} credits.\n`);
        discardTypeahead();
        const answer = await answerLine('Continue? [y/n] ', signal);
        return /^y(es)?$/i.test(answer) ? { action: 'confirm_credits' } : { action: 'decline_credits' };
      }
      case 'question': {
        if (pause.items.length === 0) {
          out('Beaver asked a question without content; it was cancelled.\n');
          return { action: 'cancel_question' };
        }
        out('Beaver has a question:\n');
        const answers: QuestionAnswer[] = [];
        for (const item of pause.items) {
          out(`${formatQuestion(item)}\n`);
          for (;;) {
            discardTypeahead();
            const got = parseQuestionAnswer(item, await answerLine(questionPrompt(item), signal));
            if (signal.aborted) return { action: 'cancel_question' };
            if ('cancel' in got) {
              out('The question was cancelled.\n');
              return { action: 'cancel_question' };
            }
            if ('answer' in got) {
              answers.push(got.answer);
              break;
            }
            out(`${got.retry}\n`);
          }
        }
        return { action: 'answer_question', answers };
      }
      case 'unsupported':
        return { action: 'stop' };
    }
  };

  let shownChat: string | null = null;
  const showResult = (r: AskResult, streamed: AnswerStream): void => {
    if (streamed.shown && !streamed.abandoned) {
      // The answer is on screen already; only the sources follow.
      if (r.sources.length > 0) out(`\n${sources(r)}\n`);
    } else if (styled) {
      // Not streamed: the same rendering as a streamed answer.
      const renderer = new AnswerRenderer({ color: useColor, width: width() });
      const text = renderer.text(r.answer) + renderer.end();
      if (text) out(`${streamed.started ? '\n' : ''}${text}`);
      if (r.sources.length > 0) out(`${text || streamed.started ? '\n' : ''}${sources(r)}\n`);
    } else {
      const text = formatAnswer(r);
      if (text) out(`${text}\n`);
    }
    if (r.thread_id && r.thread_id !== shownChat) {
      shownChat = r.thread_id;
      const line = `Chat: ${r.thread_id}`;
      io.stderr.write(`${useColor && io.stderr.isTTY ? sgr(line, { dim: true }, true) : line}\n`);
    }
    reportSideEffects(io, r);
    if (r.error?.code === 'stopped') out(`${dim('[stopped]')}\n`);
    else if (r.error) writeError(io, r.error);
    out('\n');
  };

  const send = async (text: string): Promise<void> => {
    const ac = new AbortController();
    active = ac;
    const streamed = new AnswerStream(out, (id) => names.name(id), dim, styled ? { color: useColor, width: width() } : undefined);
    stream = streamed;
    if (styled) {
      // A blank line under the prompt (the terminal ends the typed line; piped input does not).
      out(io.stdin.isTTY ? '\n' : '\n\n');
      spinner = new Spinner((s) => rawIO.stdout.write(s), useColor);
      spinner.start();
    }
    try {
      names.newRun();
      const result = await session.ask({
        thread: session.threadId !== null ? { id: session.threadId } : { new: true },
        text,
        nameOf: (id) => names.known(id),
        timeoutMs: opts.timeoutMs,
        pollMs: opts.pollMs ?? POLL_MS,
        policy,
        signal: ac.signal,
        onProgress: (e) => {
          if (e.kind === 'tool') streamed.tool(e.name, e.label);
          else if (e.kind === 'text') streamed.text(e.text);
        },
      });
      // The run is over: a name still missing is looked up once more, for good.
      names.runEnded();
      if (result.status === 'ok') await streamed.finish();
      else await streamed.settle(true);
      showResult(result, streamed);
    } catch (e) {
      await streamed.settle(true);
      const info = errorInfo(e, opts.port);
      if (info.code === 'stopped') out(`${dim('[stopped]')}\n\n`);
      else {
        writeError(io, info);
        out('\n');
      }
    } finally {
      spinner?.stop();
      spinner = null;
      active = null;
      stream = null;
    }
  };

  /** Returns false to leave the loop. */
  const command = async (line: string): Promise<boolean> => {
    const [name, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    try {
      switch (name) {
        case '/help':
          out(`${HELP}\n`);
          break;
        case '/quit':
        case '/exit':
          return false;
        case '/new':
          session.threadId = null;
          out('The next message starts a new chat.\n');
          break;
        case '/resume': {
          if (!arg) {
            out('Usage: /resume <number from /threads, or chat id>\n');
            break;
          }
          const n = /^\d+$/.test(arg) ? Number(arg) : NaN;
          if (!Number.isNaN(n) && (n < 1 || n > listed.length)) {
            out(listed.length === 0 ? 'Run /threads first, or give the chat id.\n' : `Choose a number from 1 to ${listed.length}.\n`);
            break;
          }
          await session.open({ id: Number.isNaN(n) ? arg : listed[n - 1].id });
          await printTail();
          break;
        }
        case '/threads': {
          const page = await session.threads(arg || undefined);
          listed = page.threads;
          if (listed.length === 0) out(arg ? 'No saved chat matches.\n' : 'No saved chats.\n');
          else out(`${formatThreadList(listed)}\n${dim('Continue one with /resume <number>.')}\n`);
          break;
        }
        case '/show': {
          if (session.threadId === null) {
            out('No chat yet. Send a message, or use /threads and /resume.\n');
            break;
          }
          const t = await session.transcript();
          out(`${t.title ? `${t.title}\n\n` : ''}${t.body}\n${t.references ? `\n${t.references}\n` : ''}`);
          break;
        }
        case '/status': {
          const report = await collectStatus(opts.port);
          out(`${formatStatus(report)}\n`);
          if (report.error) writeError(io, report.error);
          out(`Bound chat: ${session.threadId ?? 'none (the next message starts a new chat)'}\n`);
          break;
        }
        case '/stop':
          if (session.threadId === null) out('No chat is bound yet; nothing to stop.\n');
          else {
            let report;
            try {
              report = await session.stop();
            } catch (e) {
              if (!(e instanceof BeaverError && e.code === 'window_changed')) throw e;
              out('The Zotero window shows another chat; nothing was stopped.\n');
              break;
            }
            const { outcome, status } = report;
            if (outcome === 'not_running') out('Nothing to stop in this chat.\n');
            else if (outcome === 'unconfirmed') out(`${STOP_UNCONFIRMED}\n`);
            else if (status === 'canceled') out('Stopped.\n');
            else if (status === 'completed') out('The run had already finished.\n');
            else out(`The run ended${status ? ` (status ${status})` : ''}; check the Zotero window.\n`);
          }
          break;
        default:
          out(`Unknown command ${name}. Type /help for the list.\n`);
      }
    } catch (e) {
      writeError(io, errorInfo(e, opts.port));
    }
    return true;
  };

  try {
    if (io.stdin.isTTY) out(`${dim('Type /help for commands; Ctrl-D leaves.')}\n`);
    const prompt = styled ? `${useColor ? '\x1b[1;36m›\x1b[0m' : '›'} ` : '> ';
    const more = styled ? `${dim('…')} ` : '. ';
    for (;;) {
      let line = await reader.read({ prompt, history: true });
      if (line === null) {
        out('\n');
        break;
      }
      while (line.endsWith('\\')) {
        const next = await reader.read({ prompt: more, history: true });
        line = `${line.slice(0, -1)}\n${next ?? ''}`;
        if (next === null) break;
      }
      const text = line.trim();
      if (text === '') continue;
      if (text.startsWith('/')) {
        if (!(await command(text))) break;
        continue;
      }
      // send() never rejects; a forced exit abandons it.
      const code = await Promise.race([send(text).then(() => null), forced]);
      if (code !== null) return code;
    }
  } finally {
    stopSpinner();
    unsubscribe?.();
    reader.close();
  }
  return 0;
}
