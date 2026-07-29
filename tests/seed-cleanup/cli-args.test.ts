/**
 * Pure unit tests for the seed-cleanup CLI parser. No DB.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, validateArgv } from '../../scripts/seed-cleanup/index.js';

describe('validateArgv', () => {
  it('rejects unknown flags', () => {
    expect(() => validateArgv(['--scope', 'legacy', '--yolo'])).toThrow(/Unknown flag: --yolo/);
  });

  it('rejects --flag=value form', () => {
    expect(() => validateArgv(['--scope=legacy'])).toThrow(/must be passed as '--scope <value>'/);
  });

  it('rejects a duplicated flag', () => {
    expect(() => validateArgv(['--scope', 'legacy', '--scope', 'loadtest'])).toThrow(/more than once/);
  });

  it('rejects a value flag whose value is the next flag', () => {
    expect(() => validateArgv(['--scope', '--execute'])).toThrow(/--scope requires a value/);
  });

  it('accepts a well-formed argv', () => {
    expect(() => validateArgv(['--scope', 'legacy', '--execute', '--batch-size', '500'])).not.toThrow();
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run', () => {
    expect(parseArgs(['--scope', 'legacy']).execute).toBe(false);
  });

  it('requires a scope or a drain — there is no implicit "all"', () => {
    expect(() => parseArgs([])).toThrow(/Nothing to do/);
  });

  it('rejects an unknown scope rather than silently matching nothing', () => {
    expect(() => parseArgs(['--scope', 'seeds'])).toThrow(/Unknown --scope 'seeds'/);
  });

  it('errors on a malformed batch size instead of falling back to the default', () => {
    expect(() => parseArgs(['--scope', 'legacy', '--batch-size', 'lots'])).toThrow(/Malformed value/);
    expect(() => parseArgs(['--scope', 'legacy', '--batch-size', '0'])).toThrow(/between 1 and/);
  });

  it('bounds --batch-size so a huge value cannot defeat batching', () => {
    // An unbounded batch takes the whole population in one long-locking
    // transaction, which is exactly what batching exists to prevent.
    expect(() => parseArgs(['--scope', 'legacy', '--batch-size', '9007199254740992'])).toThrow(/between 1 and/);
    expect(() => parseArgs(['--scope', 'legacy', '--batch-size', '100000'])).toThrow(/between 1 and/);
    expect(parseArgs(['--scope', 'legacy', '--batch-size', '10000']).batchSize).toBe(10_000);
  });

  it('allows a drain with no scope', () => {
    const args = parseArgs(['--drain-ephemeral']);
    expect(args.scope).toBeNull();
    expect(args.drainEphemeral).toBe(true);
  });
});
