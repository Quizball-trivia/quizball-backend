/**
 * CLI-level guard tests (no DB writes): --execute --limit is refused, and
 * --execute without --snapshot-out is refused. Spawns the real CLI and asserts
 * it exits non-zero with the expected message BEFORE any DB work.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(__dirname, '../../scripts/bot-burnin/index.ts');
const PARAMS = resolve(__dirname, 'fixtures/params.json');

function runCli(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync('npx', ['tsx', CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: e.stderr ?? '' };
  }
}

describe('CLI execute guards', () => {
  it('refuses --execute --limit (partial burn + global marker is incoherent)', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--execute', '--snapshot-out', '/tmp/burnin-should-not-write.json', '--limit', '20']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--limit is dry-run-only/i);
  });

  it('refuses --execute without --snapshot-out', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--execute']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--snapshot-out/i);
  });
}, 60_000);
