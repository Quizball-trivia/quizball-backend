/**
 * CLI-level guard tests (no DB writes): --execute --limit is refused, and
 * --execute without an explicit --season-end is refused. Spawns the real CLI
 * and asserts it exits non-zero with the expected message BEFORE any DB work.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(__dirname, '../../scripts/bot-burnin/index.ts');
const PARAMS = resolve(__dirname, 'fixtures/params.json');

function runCli(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: e.stderr ?? '' };
  }
}

describe('CLI execute guards', () => {
  it('refuses --execute --limit (partial burn + global marker is incoherent)', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--execute', '--season-end', '2026-07-28T00:00:00Z', '--limit', '20']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--limit is dry-run-only/i);
  });

  it('refuses --execute without an explicit --season-end (run must be fully determined)', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--execute']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--season-end/i);
  });
}, 90_000);

/**
 * Strict argv validation (#343).
 *
 * Burn-in is a one-time, marker-guarded operation: on prod there is no second
 * attempt without a rollback, so an argv mistake that silently falls back to a
 * default is expensive. The parser used to ignore unrecognised tokens entirely
 * — the staging run was launched with a non-existent `--snapshot-out` and
 * accepted it without a word.
 */
describe('CLI strict arg validation', () => {
  it('rejects an unknown flag, naming it and listing the valid flags', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--snapshot-out', 'receipt.json']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown flag: --snapshot-out/i);
    // The message must be actionable — it lists what IS accepted.
    expect(stderr).toMatch(/--margin-rp/);
    expect(stderr).toMatch(/--season-end/);
  });

  it('rejects a known flag that is missing its value', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--seed']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--seed requires a value/i);
  });

  it('rejects a non-numeric value instead of falling back to the default', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--margin-rp', 'abc']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/malformed numeric value for --margin-rp/i);
    // It must NOT have silently proceeded with DEFAULT_MARGIN.
    expect(stderr).not.toMatch(/dry-run report/i);
  });

  it('accepts the approved prod command line', () => {
    const { code, stderr } = runCli([
      '--params', PARAMS,
      '--seed', '20260721',
      '--season-start', '2026-07-21',
      '--season-end', '2026-07-28T00:00:00Z',
      '--margin-rp', '50',
      '--human-top10-rp', '2615',
      '--recent-matches', '20',
    ]);
    // No ARGUMENT error. (A DB-less environment may still fail later; what must
    // not appear is an argv rejection.)
    expect(stderr).not.toMatch(/invalid arguments/i);
    expect(stderr).not.toMatch(/unknown flag/i);
    expect(stderr).not.toMatch(/requires a value/i);
    expect(stderr).not.toMatch(/malformed/i);
    if (code !== 0) expect(stderr).toMatch(/burn-in failed/i);
  });

  it('rejects the typo that silently reverted to a default (--margin for --margin-rp)', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--margin', '80']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown flag: --margin\b/i);
  });

  it('rejects --flag=value form rather than treating it as unknown noise', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--seed=7']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--seed must be passed as '--seed <value>'/i);
  });

  it('rejects a value-taking flag immediately followed by another flag', () => {
    const { code, stderr } = runCli(['--params', PARAMS, '--seed', '--execute']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--seed requires a value/i);
  });
}, 120_000);
