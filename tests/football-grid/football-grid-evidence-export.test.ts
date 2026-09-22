import { describe, expect, it } from 'vitest';
import '../setup.js';
import { checksum, manifestSchema, projectEvidence } from '../../scripts/football-grid-content.js';

const evidence = {
  sourceKey: 'official-source', sourceLocator: 'https://example.org/match', capturedFact: 'Player appeared for the club',
  rightsClass: 'facts-with-attribution', reviewedBy: 'reviewer', reviewedAt: '2026-09-22T13:22:22.753Z',
};

function stored(
  original: typeof evidence & { effectiveFrom?: string | null; effectiveTo?: string | null },
  timestamp = original.reviewedAt,
) {
  return {
    sourceKey: original.sourceKey, source_locator: original.sourceLocator, captured_fact: original.capturedFact,
    effective_from: original.effectiveFrom ?? null, effective_to: original.effectiveTo ?? null,
    rights_class: original.rightsClass, reviewed_by: original.reviewedBy, reviewed_at: timestamp,
    evidence_checksum: checksum(original),
  };
}

describe('Evidence export preserves its stored checksum', () => {
  const schema = manifestSchema.shape.memberships.element.shape.evidence.element;
  it.each(['2026-09-22T13:22Z', '2026-09-22T13:22:22.1234567Z'])(
    'rejects timestamps PostgreSQL cannot preserve before publication: %s', (reviewedAt) => {
      expect(schema.safeParse({ ...evidence, reviewedAt }).success).toBe(false);
    },
  );
  it('round-trips omitted optional dates, as used by the production corrections', () => {
    expect(projectEvidence(stored(evidence))).toEqual(evidence);
  });

  it.each([
    { effectiveFrom: null, effectiveTo: null },
    { effectiveFrom: null },
    { effectiveTo: null },
    { effectiveFrom: '2004-01-01' },
    { effectiveTo: '2005-01-01' },
    { effectiveFrom: '2004-01-01', effectiveTo: null },
  ])('preserves explicit dates and the original null/omitted choice: %j', (dates) => {
    const original = { ...evidence, ...dates };
    expect(projectEvidence(stored(original))).toEqual(original);
  });

  it.each([
    '2026-09-22T13:22:22Z', '2026-09-22T13:22:22.000Z', '2026-09-22T13:22:22.000000Z',
    '2026-09-22T13:22:22.123456Z', '2026-09-22T13:22:22.753000Z',
  ])('retains exact timestamp precision: %s', (reviewedAt) => {
    const original = { ...evidence, effectiveFrom: null, effectiveTo: null, reviewedAt };
    expect(schema.parse(original)).toEqual(original);
    const databaseText = reviewedAt.replace('T', ' ').replace('Z', '+00').replace(/\.0+(?=\+)/, '');
    expect(projectEvidence(stored(original, databaseText))).toEqual(original);
  });

  it('rejects a changed fact instead of repairing its checksum', () => {
    expect(() => projectEvidence({ ...stored(evidence), captured_fact: 'Different football relationship' }))
      .toThrow('does not reproduce');
  });

  it('never drops a stored non-null date to reproduce an older checksum', () => {
    expect(() => projectEvidence({ ...stored(evidence), effective_from: '2004-01-01' }))
      .toThrow('does not reproduce');
  });

  it('does not truncate changed microseconds to match an older timestamp', () => {
    const original = { ...evidence, effectiveFrom: null, effectiveTo: null, reviewedAt: '2026-09-22T13:22:22.753Z' };
    expect(() => projectEvidence(stored(original, '2026-09-22 13:22:22.753001+00')))
      .toThrow('does not reproduce');
  });
});
