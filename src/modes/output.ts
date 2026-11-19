import type { CliIO } from '../cli.js';
import { BeaverError, type ErrorCode } from '../core/errors.js';
import { formatSourceList } from '../core/result.js';
import type { AskResult } from '../core/session.js';

export const SCHEMA_VERSION = 1;

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  next_step: string;
}

/** Turns anything thrown into the error object of the JSON output; never leaks a stack trace. */
export function errorInfo(e: unknown, port = 23119): ErrorInfo {
  if (e instanceof BeaverError) return { code: e.code, message: e.message, next_step: e.nextStep };
  const message = `Unexpected failure: ${e instanceof Error ? e.message : String(e)}`;
  return { code: 'protocol', message, next_step: new BeaverError('protocol', message, { port }).nextStep };
}

/** The result shape for a call that failed before anything was asked. */
export function emptyAskResult(error: ErrorInfo): AskResult {
  return {
    status: 'error',
    thread_id: null,
    thread_name: null,
    run_id: null,
    sent_run_id: null,
    answer: '',
    references: '',
    sources: [],
    applied_actions: [],
    declined_actions: [],
    unresolved_items: [],
    warnings: [],
    error,
  };
}

/** Exactly one JSON object on one stdout line. */
export function writeJson(io: CliIO, obj: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, ...obj })}\n`);
}

export function writeError(io: CliIO, error: { message: string; next_step: string }): void {
  io.stderr.write(`beaver: ${error.message}\nNext: ${error.next_step}\n`);
}

/** The answer, then a blank line and the source list when there are sources. */
export function formatAnswer(r: AskResult): string {
  let out = r.answer;
  if (r.sources.length > 0) out += `${out ? '\n\n' : ''}Sources:\n${formatSourceList(r.sources)}`;
  return out;
}

/** Applied and declined changes and warnings, one stderr line each. */
export function reportSideEffects(io: CliIO, r: AskResult): void {
  for (const a of r.applied_actions) io.stderr.write(`Applied: ${a.type} (${a.id})\n`);
  for (const a of r.declined_actions) {
    const how = a.apply_command ? `Apply it with: ${a.apply_command}` : 'Apply it in the Zotero window (Apply on its card).';
    io.stderr.write(`Declined: ${a.type} (${a.id}). ${how}\n`);
  }
  for (const w of r.warnings) io.stderr.write(`beaver: ${w}\n`);
}
