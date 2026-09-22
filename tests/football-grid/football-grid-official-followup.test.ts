import { describe, expect, it } from 'vitest';
import facts from '../../scripts/football-grid-content-generator/official-answer-followup-20260923.json' with { type: 'json' };
import { approveAnswerCorrections, CONFIRMED_FACTS, CORRECTION_SOURCE, OFFICIAL_FOLLOWUP_BATCH, OFFICIAL_FOLLOWUP_SOURCE, prepareAnswerCorrections } from '../../scripts/football-grid-answer-corrections.js';
import { matchesPrescribedAnswerCorrection, type Manifest } from '../../scripts/football-grid-content.js';
import { normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../../src/modules/football-grid/football-grid.answer-resolver.js';

const at = '2026-09-23T01:00:00.000Z';
function source(): Manifest {
  const allFacts = [...CONFIRMED_FACTS, ...facts];
  const players = [...new Map(allFacts.map(f => [f.playerId, f])).values()].map(f => ({
    id: f.playerId, nameEn: f.nameEn, nameKa: `მოთამაშე ${f.playerId}`, imageAssetKey: `/players/${f.playerId}.webp`,
  }));
  return {
    release: { version: 100, aliasVersion: 2, resolverPolicyVersion: 1, approvedBy: 'previous-review', approvedAt: at,
      relationshipSnapshot: { transform: 'answer-coverage-correction-v1', correctionReviewStatus: 'approved' } },
    sources: [{ key: CORRECTION_SOURCE, providerName: 'Previous official corrections', datasetVersion: 'previous',
      permittedUse: 'Individually cited facts', databaseRightsStatus: 'approved', approvalOwner: 'previous-review',
      approvedAt: at, retentionRequirements: 'Keep evidence' }],
    players, assetCatalog: players.map(p => p.imageAssetKey),
    aliases: players.map(p => ({ playerId: p.id, alias: p.nameEn, normalizedAlias: normalizeFootballGridAnswer(p.nameEn),
      locale: 'en', aliasType: 'full_name', acceptancePolicy: 'exact', reviewedBy: 'fixture', reviewedAt: at })),
    criteria: [...new Set(allFacts.flatMap(f => [...f.criteria]))].map(key => ({ key, family: 'club', subtype: 'fixture',
      labelEn: key, labelKa: key, metadata: {}, difficulty: 'normal', familiarityScore: 50 })),
    memberships: CONFIRMED_FACTS.flatMap(f => f.criteria.map(criterionKey => ({ criterionKey, playerId: f.playerId,
      relationshipSubtype: 'fixture', verifiedBy: 'previous-review', reviewedAt: at,
      evidence: [{ sourceKey: CORRECTION_SOURCE, sourceLocator: f.url, capturedFact: f.fact,
        rightsClass: 'fixture', reviewedBy: 'previous-review', reviewedAt: at }] }))), boards: [],
  };
}

describe('official follow-up correction batch', () => {
  it('preserves the exact catalog identity and its existing clean answer alias', () => {
    const vidic = facts.find(f => f.playerId === 'abd0e4b9-8f33-4866-a90e-61c207e94379')!;
    expect(vidic.nameEn).toBe('Nemanja Vidic\u200e');
    const original = source();
    original.aliases.push({ playerId: vidic.playerId, alias: 'Nemanja Vidic', normalizedAlias: 'nemanja vidic',
      locale: 'en', aliasType: 'full_name', acceptancePolicy: 'unique_only', reviewedBy: 'fixture', reviewedAt: at });
    const candidate = prepareAnswerCorrections(original, original, 101, at, OFFICIAL_FOLLOWUP_BATCH).candidate;
    expect(candidate.players.find(p => p.id === vidic.playerId)?.nameEn).toBe(vidic.nameEn);
    const resolved = resolveFootballGridAnswer({ submittedText: 'Nemanja Vidic',
      aliases: candidate.aliases.map((a, i) => ({ ...a, id: String(i) })),
      validPlayerIds: [vidic.playerId], boardPlayerIds: [vidic.playerId], usedPlayerIds: [] });
    expect(resolved).toMatchObject({ outcome: 'correct', playerId: vidic.playerId });
  });

  it('adds the 63 cited relationships after the previous correction without mutating the source', () => {
    const original = source();
    const before = JSON.stringify(original);
    const draft = prepareAnswerCorrections(original, original, 101, at, OFFICIAL_FOLLOWUP_BATCH);
    expect(JSON.stringify(original)).toBe(before);
    expect(new Set(facts.map(f => `${f.playerId}:${f.criteria[0]}`)).size).toBe(63);
    expect(draft.changes.addedMemberships).toHaveLength(63);
    expect(draft.candidate.sources[0]).toEqual(original.sources[0]);
    expect(draft.candidate.sources.at(-1)).toMatchObject({ key: OFFICIAL_FOLLOWUP_SOURCE, databaseRightsStatus: 'pending_review' });
    const approved = approveAnswerCorrections(draft, 'reviewer', at);
    expect(matchesPrescribedAnswerCorrection(original, original, approved)).toBe(true);
    expect(() => prepareAnswerCorrections(approved, approved, 102, at, OFFICIAL_FOLLOWUP_BATCH)).toThrow('already contains');
    expect(() => prepareAnswerCorrections(original, original, 101, at)).toThrow('already contains');
  });

  it('rejects invented batches and cannot approve bulk historical sources through this batch', () => {
    const original = source();
    expect(() => prepareAnswerCorrections(original, original, 101, at, 'invented')).toThrow('Unknown');
    const draft = prepareAnswerCorrections(original, original, 101, at, OFFICIAL_FOLLOWUP_BATCH);
    draft.candidate.sources.push({ ...draft.candidate.sources.at(-1)!, key: 'unreviewed-bulk-archive' });
    expect(() => approveAnswerCorrections(draft, 'reviewer', at)).toThrow('Unexpected unreviewed source');
  });

  it('preserves the baseline fixes when starting from an older staging source', () => {
    const old = source();
    old.sources = [{ ...old.sources[0], key: 'original-source' }];
    old.memberships = [];
    const directly = prepareAnswerCorrections(old, old, 102, at, OFFICIAL_FOLLOWUP_BATCH).candidate;
    const baseline = approveAnswerCorrections(prepareAnswerCorrections(old, old, 101, at), 'reviewer', at);
    const sequentially = prepareAnswerCorrections(baseline, baseline, 102, at, OFFICIAL_FOLLOWUP_BATCH).candidate;
    const pairs = (m: typeof directly) => m.memberships.map(x => `${x.criterionKey}:${x.playerId}`).sort();
    expect(pairs(directly)).toEqual(pairs(sequentially));
    expect(directly.aliases).toEqual(sequentially.aliases);
    expect(pairs(directly)).toContain('manager:arsene-wenger:662e7c41-0436-4be0-a5dc-8b3fabe93ecf');
  });

  it('keeps the publisher bound to the exact cited facts, identities and source bytes', () => {
    const original = source();
    const approved = approveAnswerCorrections(prepareAnswerCorrections(original, original, 101, at, OFFICIAL_FOLLOWUP_BATCH), 'reviewer', at);
    const modified = structuredClone(approved);
    modified.memberships[0].evidence[0].capturedFact = 'Different claim';
    expect(matchesPrescribedAnswerCorrection(original, original, modified)).toBe(false);
    const changedIdentity = source();
    changedIdentity.players[0].nameEn = 'Different player';
    expect(() => prepareAnswerCorrections(changedIdentity, changedIdentity, 101, at, OFFICIAL_FOLLOWUP_BATCH)).toThrow('identity mismatch');
  });

  it('accepts Pique in the Premier League while leaving an unrelated Arsenal answer wrong', () => {
    const original = source();
    const candidate = prepareAnswerCorrections(original, original, 101, at, OFFICIAL_FOLLOWUP_BATCH).candidate;
    const resolve = (criterion: string, submittedText: string) => resolveFootballGridAnswer({
      submittedText, aliases: candidate.aliases.map((a, i) => ({ ...a, id: String(i) })),
      validPlayerIds: candidate.memberships.filter(m => m.criterionKey === criterion).map(m => m.playerId),
      boardPlayerIds: candidate.players.map(p => p.id), usedPlayerIds: [],
    });
    expect(resolve('league:premier-league', 'Piqué')).toMatchObject({ outcome: 'correct', playerId: '769e1327-0c83-4245-bd8b-1362c8dce939' });
    expect(resolve('club:arsenal', 'Piqué').outcome).toBe('wrong');
  });
});
