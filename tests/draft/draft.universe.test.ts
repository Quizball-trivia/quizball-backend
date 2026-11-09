import { describe, expect, it } from 'vitest';
import { draftPackSchema } from '../../src/modules/draft/draft.universe.js';
import { inventedPack } from './draft.fixture.js';

const issues = (pack: unknown): string[] => { const r = draftPackSchema.safeParse(pack); return r.success ? [] : r.error.issues.map((i) => i.message); };

describe('a pack', () => {
  it('accepts the invented pack', () => {
    expect(issues(inventedPack())).toEqual([]);
  });
  it('refuses a club in a league the pack does not have', () => {
    const pack = inventedPack();
    pack.clubs[0] = { ...pack.clubs[0], league: 'nowhere' };
    expect(issues(pack)).toContain('unknown league nowhere');
  });
  it('refuses a finish below the bottom of the table', () => {
    const pack = inventedPack();
    const teams = pack.leagues.find((l) => l.id === pack.clubs[0].league)!.teams;
    pack.clubs[0] = { ...pack.clubs[0], finish: teams + 1 };
    expect(issues(pack).some((m) => m.startsWith(`finish ${teams + 1}`))).toBe(true);
  });
  it('refuses the same club and year twice', () => {
    const pack = inventedPack();
    pack.clubs.push({ ...pack.clubs[0] });
    expect(issues(pack).some((m) => m.endsWith('appears twice'))).toBe(true);
  });
});
