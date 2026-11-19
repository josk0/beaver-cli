#!/usr/bin/env node
import { runCli } from './cli.js';

const interrupt = new AbortController();
const listeners = new Set<() => void>();

// Interactive mode registers a listener and handles Ctrl-C itself; script mode gets an abort
// signal (the command tries to stop its run and reports the partial answer). A second Ctrl-C in script mode ends
// the process at once.
process.on('SIGINT', () => {
  if (listeners.size > 0) {
    for (const l of [...listeners]) l();
    return;
  }
  if (interrupt.signal.aborted) process.exit(130);
  interrupt.abort();
});

runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  signal: interrupt.signal,
  // Flush stdout before leaving: writes to a pipe are asynchronous on macOS.
  exit: (code) => {
    process.stdout.write('', () => process.exit(code));
  },
  onInterrupt: (handler) => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`beaver: unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
