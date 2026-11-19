import { describe, expect, it } from 'vitest';
import { BeaverError, EXIT_CODES, nextStepFor, type ErrorCode } from '../../src/core/errors.js';

describe('errors', () => {
  it('keeps the exit codes of the first version and adds the codes of the chat routes', () => {
    expect(EXIT_CODES).toMatchObject({
      usage: 2, zotero_unreachable: 10, beaver_unavailable: 11, no_window: 12, busy_run: 13,
      thread_not_found: 14, send_failed: 15, run_error: 16, timeout: 17, stopped: 18,
      unsupported_pause: 19, account_changed: 20, protocol: 21, window_changed: 22,
    });
    expect(EXIT_CODES).toMatchObject({
      not_authenticated: 11,
      busy_draft: 13, busy_attachments: 13, busy_cards: 13, thread_busy: 13, thread_conflict: 13,
      thread_other_instance: 14,
      send_unknown: 15, library_excluded: 15,
      library_access_changed: 20,
      run_not_found: 21, action_not_found: 21, action_not_pending: 21, use_approve: 21, duplicate_run: 21,
    });
  });

  it('gives every code a one-sentence next step, mentioning the port where it helps', () => {
    for (const code of Object.keys(EXIT_CODES) as ErrorCode[]) {
      expect(nextStepFor(code, { port: 23126 }).length).toBeGreaterThan(10);
    }
    expect(nextStepFor('zotero_unreachable', { port: 23126 })).toContain('23126');
  });

  it('every error code exits non-zero and not with the crash code 1', () => {
    for (const code of Object.keys(EXIT_CODES) as ErrorCode[]) expect(EXIT_CODES[code]).toBeGreaterThan(1);
  });

  it('window_changed tells the person how to continue the chat; send_unknown warns against a resend', () => {
    expect(nextStepFor('window_changed', { port: 23119 })).toContain('-r <chat id>');
    expect(nextStepFor('send_unknown', { port: 23119 })).toContain('before sending it again');
  });

  it('BeaverError carries code, nextStep and detail; a next step can be given', () => {
    const e = new BeaverError('busy_run', 'A run is in progress', { port: 23119 }, { x: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('busy_run');
    expect(e.message).toBe('A run is in progress');
    expect(e.nextStep).toBe(nextStepFor('busy_run', { port: 23119 }));
    expect(e.detail).toEqual({ x: 1 });
    expect(new BeaverError('protocol', 'x', { port: 1, nextStep: 'Do this.' }).nextStep).toBe('Do this.');
  });
});
