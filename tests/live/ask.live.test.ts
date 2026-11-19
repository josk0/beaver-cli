/**
 * Live tests against a running, signed-in Zotero with a Beaver build whose 'Terminal and script
 * access' setting is on. Opt-in: set BEAVER_PORT. Each agent run spends real Beaver credits; this file
 * starts at most four (tests 1, 2, 5 and 6). No prompt asks for a library change.
 *
 * BEAVER_LIVE_OUT (optional): a directory where the JSON output of test 1 is saved.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../../src/cli.js';
import { connect, type BeaverClient } from '../../src/client/http.js';

const PORT = process.env.BEAVER_PORT;
const ZERO = '00000000-0000-4000-8000-000000000000';
const ITEM = 'PVX9VYC4'; // Holm 2023, "The Fairness in Algorithmic Fairness", personal library

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(args: string[], stdinText?: string): Promise<Run> {
  let out = '';
  let err = '';
  const stdin = new PassThrough();
  if (stdinText !== undefined) stdin.end(stdinText);
  const io: Partial<CliIO> = {
    stdin,
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env: { BEAVER_PORT: PORT },
  };
  const code = await runCli(args, io);
  return { code, out, err };
}

const json = (r: Run) => JSON.parse(r.out.trim());

describe.skipIf(!PORT)(`live: Beaver on port ${PORT}`, () => {
  let client: BeaverClient;
  let threadId: string | null = null;
  /** The run the last agent call reported, so a failed test's run can be stopped. */
  let lastRun: { runId: string; threadId: string | null } | null = null;

  const remember = (j: { run_id?: string | null; thread_id?: string | null }) => {
    if (j.run_id) lastRun = { runId: j.run_id, threadId: j.thread_id ?? null };
  };

  /** Stops a run that a failed test left going, so nothing keeps spending credits. */
  async function stopLeftoverRun(): Promise<void> {
    if (!lastRun) return;
    try {
      await client.stop({ runId: lastRun.runId, threadId: lastRun.threadId });
    } catch {
      // the next test reports a broken instance
    }
  }

  beforeAll(async () => {
    // BEAVER_PORT is set, so an unreachable, switched-off or signed-out instance is a failure, not a skip.
    client = (await connect({ port: Number(PORT) })).client;
  });
  afterEach(stopLeftoverRun);
  afterAll(stopLeftoverRun);

  it('1: -p --json, new chat with an attached item, answers with a cited source', async () => {
    const r = await cli([
      '-p',
      '--json',
      '--item',
      ITEM,
      'In one sentence, what does this paper argue? Then quote one sentence from this paper and cite the page. Answer in this chat only.',
    ]);
    if (process.env.BEAVER_LIVE_OUT) writeFileSync(join(process.env.BEAVER_LIVE_OUT, 'live-test-1.json'), r.out);
    const j = json(r);
    remember(j);
    expect(j.schema_version).toBe(1);
    expect(j.status, JSON.stringify(j.error)).toBe('ok');
    expect(r.code).toBe(0);
    expect(j.answer.length).toBeGreaterThan(0);
    expect(j.answer).not.toContain('<citation');
    expect(j.unresolved_items).toEqual([]);
    expect(j.sources.length).toBeGreaterThanOrEqual(1);
    expect(j.sources.some((s: { item_key: string }) => /^[A-Z0-9]{8}$/.test(s.item_key))).toBe(true);
    // A citation of the attached item's PDF is reported under the item itself.
    expect(j.sources.map((s: { item_key: string }) => s.item_key)).toContain(ITEM);
    console.log(`[live 1] sources ${JSON.stringify(j.sources.map((s: { item_key: string; pages?: number[] }) => [s.item_key, s.pages]))}`);
    expect(typeof j.thread_id).toBe('string');
    threadId = j.thread_id;
  });

  it('2: -r <thread> continues the same chat', async (ctx) => {
    if (!threadId) return ctx.skip(); // no run spent without a chat from test 1
    const r = await cli(['-p', '--json', '-r', threadId, 'Reply with the single word OK.']);
    const j = json(r);
    remember(j);
    expect(j.status, JSON.stringify(j.error)).toBe('ok');
    expect(j.thread_id).toBe(threadId);
    expect(j.answer).toContain('OK');
  });

  it('3: an unknown -r id exits 14 and changes no saved chat', async () => {
    const before = (await client.threads({ limit: 5 })).threads.map((t) => [t.id, t.updated_at]);
    const r = await cli(['-p', '--json', '-r', ZERO, 'x']);
    expect(r.code).toBe(14);
    expect(json(r).error.code).toBe('thread_not_found');
    const after = (await client.threads({ limit: 5 })).threads.map((t) => [t.id, t.updated_at]);
    expect(after).toEqual(before);
  });

  it('3b: threads lists the chat of test 1; apply of an unknown change is action_not_found (no agent run)', async (ctx) => {
    if (!threadId) return ctx.skip();
    const t = json(await cli(['threads', '--json']));
    expect(t.error).toBeNull();
    expect(t.threads.map((x: { id: string }) => x.id)).toContain(threadId);
    const a = await cli(['apply', ZERO, '-r', threadId, '--json']);
    expect(a.code).toBe(21);
    expect(json(a).error.code).toBe('action_not_found');
  });

  it('4: status --json reports reachable and signed in', async () => {
    const r = await cli(['status', '--json']);
    const j = json(r);
    expect(r.code).toBe(0);
    expect(j.reachable).toBe(true);
    expect(j.beaver_available).toBe(true);
    expect(j.interface_version).toBe(1);
    expect(j.error).toBeNull();
  });

  it('5: --timeout 2 on a long answer ends with 0 or 17, and no run is left pending', async () => {
    const t0 = Date.now();
    const r = await cli(['-p', '--json', '--timeout', '2', 'Write 400 words about the history of libraries. Do not search the library.']);
    const elapsed = Date.now() - t0;
    const j = json(r);
    remember(j);
    expect([0, 17]).toContain(r.code);
    if (r.code === 17) expect(j.error.code).toBe('timeout');
    let active = true;
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      active = (await client.status({ runId: j.run_id, threadId: j.thread_id })).is_active;
      if (!active) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    console.log(`[live 5] exit ${r.code}, ${elapsed} ms, warnings ${JSON.stringify(j.warnings)}, answer ${j.answer.length} chars`);
    expect(active).toBe(false);
  });

  it('6: interactive, one message then end of input', async () => {
    const r = await cli([], 'Reply with the single word OK.\n');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('OK');
  });
});
