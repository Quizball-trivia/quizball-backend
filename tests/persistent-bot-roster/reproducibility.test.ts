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
import { renderReport, renderCsv } from '../../scripts/persistent-bot-roster/report.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const patternsPath = path.resolve(dir, '../../scripts/persistent-bot-roster/patterns.json');
const patterns = JSON.parse(readFileSync(patternsPath, 'utf8')) as RosterPatterns;

const SEED = 20260727;

describe('reproducibility against committed patterns.json', () => {
  it('regenerating with the same seed yields the identical 1,000 nicknames', () => {
    const a = generateRoster({ seed: SEED, count: 1000, patterns });
    const b = generateRoster({ seed: SEED, count: 1000, patterns });
    expect(a.map((x) => x.nickname)).toEqual(b.map((x) => x.nickname));
  });

  it('all 1,000 are unique and none collide with the frozen exclusion set', () => {
    const bots = generateRoster({ seed: SEED, count: 1000, patterns });
    const excl = new Set(patterns.exclusion.names);
    const seen = new Set<string>();
    for (const b of bots) {
      const k = normalizeForExclusion(b.nickname);
      expect(seen.has(k)).toBe(false);
      expect(excl.has(k)).toBe(false);
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

  it('the frozen exclusion set matches its recorded sha256', () => {
    const recomputed = createHash('sha256')
      .update(patterns.exclusion.names.join('\n'))
      .digest('hex');
    expect(recomputed).toBe(patterns.exclusion.sha256);
    expect(patterns.exclusion.names.length).toBe(patterns.exclusion.count);
  });
});
