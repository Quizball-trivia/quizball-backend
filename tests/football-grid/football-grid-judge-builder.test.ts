import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.hoisted(() => {
  process.env.FOOTBALL_GRID_RISK_HASH_SECRET = 'judge-builder-test-secret-000000000001';
});

import {
  BINDING_MIN_OVERLAP,
  certifyBoard,
  decideBindings,
  evidenceShowsAppearance,
  factId,
  routeFact,
  semanticLabel,
  type CriterionRow,
} from '../../src/modules/football-grid/football-grid-judge-builder.js';
import { canonicalFootballGridBoardChecksum } from '../../src/modules/football-grid/football-grid.content-validator.js';
import { footballGridJudgeCohort } from '../../src/modules/football-grid/football-grid-judge.service.js';
import { assertFootballGridSoloTicket, signFootballGridSoloTicket } from '../../src/modules/football-grid/football-grid-solo.service.js';
import { judgeVersionFor, newState, pinJudgeVersion, kickOff, miss } from '../../src/modules/grid-daily/grid-daily.rules.js';

// Invented universe: Lumen clubs, Vesper countries, Quill players. No real football content.
const row = (overrides: Partial<CriterionRow>): CriterionRow => ({
  id: overrides.id ?? `c-${Math.random()}`,
  key: 'club:lumen-athletic',
  family: 'club',
  subtype: 'senior-club-appearance',
  labelEn: 'Lumen Athletic',
  releaseVersion: 1,
  overlap: 1,
  ...overrides,
});

describe('criterion bindings', () => {
  it('binds rows of one key that agree on shape, meaning and members to one definition', () => {
    const { decisions, definitions } = decideBindings([
      row({ id: 'a', releaseVersion: 1, overlap: 0.95 }),
      row({ id: 'b', releaseVersion: 2 }),
    ]);
    expect(definitions).toHaveLength(1);
    expect(decisions.every((decision) => decision.status === 'bound' && decision.definitionKey === definitions[0].definitionKey)).toBe(true);
  });

  it('keeps European and themed shapes apart: a key is an identity only with its family and subtype', () => {
    const { definitions } = decideBindings([
      row({ id: 'a', key: 'club:lumen-athletic' }),
      row({ id: 'b', key: 'club-lumen-athletic', subtype: 'played_for' }),
    ]);
    expect(definitions.map((definition) => definition.definitionKey).sort()).toEqual([
      'club|played_for|club-lumen-athletic|v1',
      'club|senior-club-appearance|club:lumen-athletic|v1',
    ]);
  });

  it('marks a relabelled criterion ambiguous, except the reviewed teammate rewording', () => {
    const relabelled = decideBindings([
      row({ id: 'a', labelEn: 'Lumen Athletic' }),
      row({ id: 'b', labelEn: 'Lumen Athletic (league games only)', releaseVersion: 2 }),
    ]);
    expect(relabelled.decisions.every((decision) => decision.status === 'ambiguous')).toBe(true);
    expect(semanticLabel('teammate', 'Played with Ivo Quill')).toBe(semanticLabel('teammate', 'Club teammate of Ivo Quill'));
    const teammate = decideBindings([
      row({ id: 'a', key: 'teammate:00000000-0000-4000-8000-000000000001', family: 'teammate', subtype: 'same-club-season', labelEn: 'Played with Ivo Quill' }),
      row({ id: 'b', key: 'teammate:00000000-0000-4000-8000-000000000001', family: 'teammate', subtype: 'same-club-season', labelEn: 'Club teammate of Ivo Quill', releaseVersion: 2 }),
    ]);
    expect(teammate.decisions.every((decision) => decision.status === 'bound')).toBe(true);
  });

  it('marks a row whose members disagree with the newest release ambiguous, and a reviewed override decides', () => {
    const rows = [row({ id: 'old', overlap: BINDING_MIN_OVERLAP - 0.01 }), row({ id: 'new', releaseVersion: 2 })];
    const auto = decideBindings(rows);
    expect(auto.decisions.find((decision) => decision.criterionId === 'old')).toMatchObject({ status: 'ambiguous' });
    expect(auto.decisions.find((decision) => decision.criterionId === 'new')).toMatchObject({ status: 'bound' });
    const reviewed = decideBindings(rows, [{ criterionKey: 'club:lumen-athletic', decision: 'bind', reviewer: 'reviewer-a' }]);
    expect(reviewed.decisions.every((decision) => decision.status === 'bound')).toBe(true);
    const vetoed = decideBindings(rows, [{ criterionKey: 'club:lumen-athletic', decision: 'ambiguous', reviewer: 'reviewer-a' }]);
    expect(vetoed.decisions.every((decision) => decision.status === 'ambiguous')).toBe(true);
  });

  it('never binds a key whose family or subtype differs between releases', () => {
    const { decisions } = decideBindings([row({ id: 'a' }), row({ id: 'b', subtype: 'played_for', releaseVersion: 2 })]);
    expect(decisions.every((decision) => decision.status === 'ambiguous')).toBe(true);
  });
});

describe('fact routing', () => {
  const keys = new Map([
    ['trophy:vesper-cup', 'trophy_award|winning-campaign-appearance|trophy:vesper-cup|v1'],
    ['club:lumen-athletic', 'club|senior-club-appearance|club:lumen-athletic|v1'],
  ]);

  it('lands a trophy fact on the appearance definition only when its evidence shows a campaign appearance', () => {
    const appearance = routeFact({ player_id: 'p', criterion_key: 'trophy:vesper-cup', family: 'trophy_award',
      evidence: [{ source: 'EU', detail: 'made a recorded competition appearance in the winning campaign' }] }, keys);
    expect(appearance).toEqual({ kind: 'definition', definitionKey: keys.get('trophy:vesper-cup') });
    const squad = routeFact({ player_id: 'p', criterion_key: 'trophy:vesper-cup', family: 'trophy_award',
      evidence: [{ source: 'D', detail: 'in the squad that season' }] }, keys);
    expect(squad).toMatchObject({ kind: 'squad-rule', definition: { subtype: 'winning-squad', predicate: 'in-winning-squad-that-season' } });
    // A stated absence is not an appearance, whatever else the evidence mentions.
    const unused = routeFact({ player_id: 'p', criterion_key: 'trophy:vesper-cup', family: 'trophy_award',
      evidence: [{ source: 'EU', detail: 'unused substitute; no appearances in the winning campaign' }] }, keys);
    expect(unused).toMatchObject({ kind: 'squad-rule' });
    expect(evidenceShowsAppearance('Ivo Quill made a recorded competition appearance in 1 title-winning campaign')).toBe(true);
    expect(evidenceShowsAppearance('season statistics table: 3 Vesper Cup apps')).toBe(true);
    expect(evidenceShowsAppearance('0 Vesper Cup apps')).toBe(false);
    expect(evidenceShowsAppearance('listed in the squad; did not play')).toBe(false);
    const reviewed = routeFact({ player_id: 'p', criterion_key: 'trophy:vesper-cup', family: 'trophy_award', origin: 'checked-report',
      evidence: [{ source: 'D', detail: 'in the squad that season' }] }, keys, new Set(['checked-report']));
    expect(reviewed).toMatchObject({ kind: 'definition' });
  });

  it('lands other facts on the bound definition of their key, and refuses unknown keys', () => {
    expect(routeFact({ player_id: 'p', criterion_key: 'club:lumen-athletic', family: 'club' }, keys)).toMatchObject({ kind: 'definition' });
    expect(routeFact({ player_id: 'p', criterion_key: 'club:nowhere', family: 'club' }, keys)).toEqual({ kind: 'unknown-criterion' });
  });

  it('gives a fact a stable id', () => {
    expect(factId({ player_id: 'p', criterion_key: 'k' })).toBe(factId({ player_id: 'p', criterion_key: 'k' }));
    expect(factId({ player_id: 'p', criterion_key: 'k' })).not.toBe(factId({ player_id: 'q', criterion_key: 'k' }));
  });
});

describe('builder command line', () => {
  it('refuses a flag given without its value, and accepts exact flags only', async () => {
    const { parseArgs } = await import('../../scripts/football-grid-judge-build.js');
    expect(() => parseArgs(['--target', 'staging', '--label', 'compat-x', '--compat-only', '--facts'])).toThrow(/--facts needs a value/);
    expect(() => parseArgs(['--facts', '--compat-only'])).toThrow(/--facts needs a value/);
    expect(() => parseArgs(['--factsdir', '/private/x'])).toThrow(/Unknown argument/);
    const compat = parseArgs(['--label=compat-x', '--compat-only']);
    expect(compat).toMatchObject({ label: 'compat-x', compatOnly: true });
    expect(compat.facts).toBeUndefined();
    expect(parseArgs(['--facts', '/private/facts', '--appearance-rule-origins', 'a, b'])).toMatchObject({ facts: '/private/facts', appearanceOrigins: ['a', 'b'] });
  });
});

describe('board certification', () => {
  const rows = ['club:lumen-a', 'club:lumen-b', 'club:lumen-c'].map((key, i) => ({ id: `r${i}`, key, difficulty: 'easy' as const }));
  const columns = ['country:va', 'country:vb', 'country:vc'].map((key, i) => ({ id: `k${i}`, key, difficulty: 'easy' as const }));
  const checksum = canonicalFootballGridBoardChecksum(rows.map((r) => r.key) as [string, string, string], columns.map((c) => c.key) as [string, string, string]);
  const cells = Array.from({ length: 9 }, (_, cell) => [0, 1, 2].map((i) => `p${cell}-${i}`));
  const names = new Map(cells.flat().map((id) => [id, { nameEn: `Quill ${id}`, nameKa: null, nameRu: null, nameEl: null }]));

  it('certifies a playable board, choice included', () => {
    const result = certifyBoard({ boardId: 'b', theme: 'invented', checksum, rows, columns, cells, recognizable: cells.map((cell) => cell.slice(0, 2)), names });
    expect(result).toMatchObject({ status: 'certified', metrics: { choiceOk: true } });
  });

  it('rejects a board below the bar under the version (too few recognizable answers)', () => {
    const result = certifyBoard({ boardId: 'b', theme: 'invented', checksum, rows, columns, cells, recognizable: cells.map(() => []), names });
    expect(result.status).toBe('rejected');
  });

  it('reports a board whose cells cannot offer four options as not choice-ready', () => {
    const same = Array.from({ length: 9 }, () => cells.flat());
    const result = certifyBoard({ boardId: 'b', theme: 'invented', checksum, rows, columns, cells: same, recognizable: same.map((cell) => cell.slice(0, 2)), names });
    expect(result.metrics.choiceOk).toBe(false);
  });
});

describe('pins outside a match row', () => {
  const versionId = '00000000-0000-4000-8000-00000000abcd';

  it('signs the version into a same-phone ticket and reads it back', () => {
    const ticket = signFootballGridSoloTicket('board-1', 1_000, versionId);
    expect(ticket.length).toBeLessThanOrEqual(120);
    expect(assertFootballGridSoloTicket('board-1', ticket, 1_000)).toEqual({ judgeVersionId: versionId });
    expect(assertFootballGridSoloTicket('board-1', signFootballGridSoloTicket('board-1', 1_000), 1_000)).toEqual({ judgeVersionId: null });
  });

  it('refuses a ticket whose pinned version was swapped', () => {
    const ticket = signFootballGridSoloTicket('board-1', 1_000, versionId);
    const swapped = ticket.replace(versionId, '00000000-0000-4000-8000-00000000ffff');
    expect(() => assertFootballGridSoloTicket('board-1', swapped, 1_000)).toThrow();
    expect(() => assertFootballGridSoloTicket('board-1', ticket.replace(versionId, '-'), 1_000)).toThrow();
  });

  it('keeps accepting a two-part ticket from before versions (legacy judging)', async () => {
    const { createHmac } = await import('node:crypto');
    const { footballGridSecret } = await import('../../src/modules/football-grid/football-grid-options.js');
    const expires = 10_000;
    const old = `${expires}.${createHmac('sha256', footballGridSecret()).update(`football-grid-solo:board-1:${expires}`).digest('hex')}`;
    expect(assertFootballGridSoloTicket('board-1', old, 1_000)).toEqual({ judgeVersionId: null });
  });

  it('pins a daily run on its first write only while nothing is spent, and keeps the pin through every transition', () => {
    const fresh = kickOff(newState(), 1);
    expect(judgeVersionFor(fresh, versionId)).toBe(versionId);
    const pinned = miss(pinJudgeVersion(fresh, versionId), 0, 2);
    expect(pinned.jv).toBe(versionId);
    expect(judgeVersionFor(pinned, '00000000-0000-4000-8000-00000000ffff')).toBe(versionId);
    // A run that already spent a guess before versions existed stays on the board's own answers.
    const legacy = miss(fresh, 0, 2);
    expect(legacy.jv).toBeUndefined();
    expect(judgeVersionFor(legacy, versionId)).toBeNull();
    expect(miss(pinJudgeVersion(legacy, null), 1, 3).jv).toBeNull();
  });

  it('assigns a cohort deterministically', () => {
    expect(footballGridJudgeCohort('pairing-1')).toBe(footballGridJudgeCohort('pairing-1'));
    const spread = new Set(Array.from({ length: 200 }, (_, i) => footballGridJudgeCohort(`k${i}`)));
    expect(spread.size).toBeGreaterThan(50);
  });
});
