/**
 * Reproducibility guarantee against the REAL committed patterns.json: the same
 * seed reproduces the identical roster, and the report/CSV are byte-stable. This
 * is what lets create.ts rebuild exactly what a human approved by sha256.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RosterPatterns } from '../../scripts/persistent-bot-roster/patterns.js';
import { generateRoster, normalizeForExclusion } from '../../scripts/persistent-bot-roster/roster.js';
import { exclusionMembership } from '../../scripts/persistent-bot-roster/exclusion.js';
import { renderReport, renderCsv } from '../../scripts/persistent-bot-roster/report.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const patternsPath = path.resolve(dir, '../../scripts/persistent-bot-roster/patterns.json');
const patterns = JSON.parse(readFileSync(patternsPath, 'utf8')) as RosterPatterns;

const SEED = 20260729;

describe('reproducibility against committed patterns.json', () => {
  it('regenerating with the same seed yields the identical 1,000 nicknames', () => {
    const a = generateRoster({ seed: SEED, count: 1000, patterns });
    const b = generateRoster({ seed: SEED, count: 1000, patterns });
    expect(a.map((x) => x.nickname)).toEqual(b.map((x) => x.nickname));
  });

  it('all 1,000 are unique and none collide with the frozen exclusion set', () => {
    const bots = generateRoster({ seed: SEED, count: 1000, patterns });
    const { has: isExcluded } = exclusionMembership(patterns.exclusion);
    const seen = new Set<string>();
    for (const b of bots) {
      const k = normalizeForExclusion(b.nickname);
      expect(seen.has(k)).toBe(false);
      expect(isExcluded(b.nickname)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(1000);
  });

  it('the rendered report + CSV are byte-stable across runs (approval hash is stable)', () => {
    const render = () => {
      const bots = generateRoster({ seed: SEED, count: 1000, patterns });
      return {
        report: renderReport({ seed: SEED, count: 1000, patterns, bots }),
        csv: renderCsv(bots),
      };
    };
    const r1 = render();
    const r2 = render();
    expect(createHash('sha256').update(r1.report).digest('hex'))
      .toBe(createHash('sha256').update(r2.report).digest('hex'));
    expect(createHash('sha256').update(r1.csv).digest('hex'))
      .toBe(createHash('sha256').update(r2.csv).digest('hex'));
  });

  it('the frozen exclusion set is hashed (no plaintext) and matches its digest', () => {
    // Privacy: the committed set holds salted hashes, never plaintext names.
    expect(patterns.exclusion.algorithm).toBe('sha256(salt+nfcLower)');
    expect(typeof patterns.exclusion.salt).toBe('string');
    expect((patterns.exclusion as unknown as { names?: unknown }).names).toBeUndefined();
    for (const h of patterns.exclusion.hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = createHash('sha256').update(patterns.exclusion.hashes.join('\n')).digest('hex');
    expect(recomputed).toBe(patterns.exclusion.sha256);
    expect(patterns.exclusion.hashes.length).toBe(patterns.exclusion.count);
  });
});
