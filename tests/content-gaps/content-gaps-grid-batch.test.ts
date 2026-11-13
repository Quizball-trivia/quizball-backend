import { describe, expect, it } from 'vitest';
import { batchFromFixes, gridAliasLocale, projectRef } from '../../scripts/content-gaps-grid-batch.js';

// Invented footballers only: the repository is public.
const pack = { namesById: new Map([['p1', 'Aro Bandel'], ['p2', 'Wim Xell']]), criterionKeys: new Set(['club:vale', 'club:moor']) };
const membership = (id: string, pid: string, keys: string[], url = 'https://example.org/a') =>
  ({ id, kind: 'membership', payload: { pid, criterionKeys: keys, fact: 'Played for Club Vale 2010-2012' }, evidence: [{ url, quote: 'q' }], payload_hash: `h${id}` });

describe('verified Grid fixes → private correction batch', () => {
  it('turns memberships into cited facts; holds aliases back; skips what the pack cannot carry', () => {
    const out = batchFromFixes([
      membership('1', 'p1', ['club:vale']),
      { id: '2', kind: 'alias', payload: { entityId: 'p2', locale: 'ka', text: ' ვიმ ქსელი ' }, evidence: [], payload_hash: 'h2' },
      membership('3', 'p9', ['club:vale']),
      membership('4', 'p2', ['club:vale'], 'http://insecure.example'),
      membership('5', 'p2', ['club:vale', 'club:gone']),
      membership('6', 'p2', ['club:moor']),
    ], pack, new Set(['6']));
    expect(out.facts).toEqual([{ playerId: 'p1', nameEn: 'Aro Bandel', criteria: ['club:vale'], url: 'https://example.org/a', fact: 'Played for Club Vale 2010-2012', presentOnly: true }]);
    expect(out.aliases).toEqual([]);
    expect(out.included).toEqual([{ id: '1', payloadHash: 'h1' }]);
    expect(out.skipped).toEqual([
      { id: '2', reason: 'alias: waits for alias revisions that reach existing boards' },
      { id: '3', reason: 'footballer not in the source pack' }, { id: '4', reason: 'incomplete membership' },
      { id: '5', reason: 'criterion not in the source pack' }, { id: '6', reason: 'already in an unpublished batch' },
    ]);
  });

  it('maps the eight game languages onto the Grid alias languages', () => {
    expect(['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr'].map(gridAliasLocale)).toEqual(['es', 'en', 'ka', 'tr', 'ru', 'en', 'en', 'en']);
  });

  it('reads the project from the decoded user name or host, so an encoded production URL is still production', () => {
    expect(projectRef('postgresql://postgres.%6cfbwhxvwubzeqkztghok:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres')).toBe('lfbwhxvwubzeqkztghok');
    expect(projectRef('postgresql://postgres:pw@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres')).toBe('nsdfiprfmhdqhbfxfwpv');
    expect(projectRef('postgresql://postgres@127.0.0.1:5432/x')).toBe('local');
    expect(() => projectRef('postgresql://someone:pw@db.example.com/x')).toThrow(/Cannot tell/);
  });
});
