import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BIN))('built bin (dist/main.js, after npm run build)', () => {
  it('is executable, starts with a node shebang, and prints the help', () => {
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
    const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Examples');
    expect(r.stdout).toContain('schema_version');
    const direct = spawnSync(BIN, ['--help'], { encoding: 'utf8', timeout: 10_000 });
    expect(direct.status).toBe(0);
  });
});
