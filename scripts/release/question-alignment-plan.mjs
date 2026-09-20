import { contentHash, buildQuestionManifest } from './question-manifest.mjs';
import { buildAdditiveQuestionPackage, validateQuestionPackage } from './question-package.mjs';

const FIELDS = ['category_id', 'type', 'difficulty', 'status', 'prompt', 'explanation', 'ranked_eligible', 'visibility'];
const pick = row => Object.fromEntries(FIELDS.map(key => [key, row[key] ?? null]));

/** Pure reverse-alignment plan; deliberately has no database executor.
 * Preservation must be verified before an existing staging identity can change.
 * Shared drafts use exactly the same IDs as the production preservation package.
 * Author IDs, history, timestamps and existing payload identities stay local.
 */
export function buildStagingQuestionAlignmentPlan(staging, production, promotionInput) {
  const promotion = validateQuestionPackage(promotionInput);
  if (promotion.conflictPolicy !== 'preserve-target-and-source-drafts'
      || promotion.sourceProject !== staging.project || promotion.targetProject !== production.project
      || promotion.sourceSnapshotHash !== contentHash(staging) || promotion.targetSnapshotHash !== contentHash(production)) {
    throw new Error('Alignment requires the exact approved preservation snapshots and policy');
  }
  const canonicalPromotion = buildAdditiveQuestionPackage(staging, production, { conflictPolicy: 'preserve-target-and-source-drafts' });
  if (canonicalPromotion.sha256 !== promotion.sha256) throw new Error('Preservation package does not match its source content');
  const reverse = buildAdditiveQuestionPackage(production, staging);
  const stagingCategories = new Map(staging.categories.map(row => [row.slug, row.id]));
  const productionCategorySlugs = new Map(production.categories.map(row => [row.id, row.slug]));
  for (const category of promotion.categories) productionCategorySlugs.set(category.id, category.slug);
  for (const category of reverse.categories) stagingCategories.set(category.slug, category.id);
  const stagingQuestions = new Map(staging.questions.map(row => [row.id, row]));
  const productionQuestions = new Map(production.questions.map(row => [row.id, row]));
  const stagingPayloads = new Map(staging.payloads.map(row => [row.question_id, row]));
  const productionPayloads = new Map(production.payloads.map(row => [row.question_id, row]));
  const drafts = promotion.additions.filter(item => item.kind === 'conflict-draft').map(item => ({
    ...structuredClone(item),
    provenance: { ...item.provenance, sourceProject: staging.project },
    question: { ...item.question, category_id: stagingCategories.get(productionCategorySlugs.get(item.question.category_id)) },
  }));
  if (drafts.some(item => !item.question.category_id)) throw new Error('Conflict draft category cannot be mapped');
  const conflicts = new Map(promotion.preservedConflicts.map(row => [row.sourceId, row]));
  const updates = [...conflicts].map(([id, conflict]) => {
    const before = stagingQuestions.get(id), winner = productionQuestions.get(id);
    const oldPayload = stagingPayloads.get(id), newPayload = productionPayloads.get(id);
    const after = { ...pick(winner), category_id: stagingCategories.get(productionCategorySlugs.get(winner.category_id)) };
    if (!after.category_id) throw new Error('Winning category cannot be mapped');
    const baseline = { question: pick(before), payloadId: oldPayload.id, payload: oldPayload.payload };
    return { id, draftId: conflict.draftId, baseline, beforeHash: contentHash(baseline),
      after: { question: after, payloadId: oldPayload.id, payload: newPayload.payload },
      productionEditorialHash: conflict.targetHash, stagingEditorialHash: conflict.sourceHash };
  });
  const { sha256: ignored, ...preservationBody } = reverse;
  preservationBody.conflictPolicy = 'preserve-target-and-source-drafts';
  preservationBody.additions = [...reverse.additions, ...drafts];
  preservationBody.preservedConflicts = structuredClone(promotion.preservedConflicts);
  preservationBody.unresolvedConflicts = [];
  const preservation = validateQuestionPackage({ ...preservationBody, sha256: contentHash(preservationBody) });
  const manifest = buildQuestionManifest(staging, production);
  const body = {
    format: 1, executable: false, direction: 'production-canonical-content-to-staging',
    sourceProject: production.project, targetProject: staging.project,
    productionSnapshotHash: contentHash(production), stagingSnapshotHash: contentHash(staging),
    promotionPackageSha256: promotion.sha256, preservation, updates,
    unchangedShared: manifest.entries.filter(row => row.disposition === 'identical').length,
    stagingOnlyRetained: manifest.entries.filter(row => !row.targetId).map(row => row.sourceId),
    gates: [
      'Reserve staging editorial writes and refresh both snapshots before execution.',
      'Import and verify every conflict draft and its payload before changing originals.',
      'Verify embedded player/media identities and category references in winning payloads.',
      'Inspect staging event/history references; preserve their original content before alignment.',
      'Use bounded locked compare-and-swap writes with durable before/after receipts and tested undo.',
      'Publish production-only additions and staging-only production imports through explicit reviewed selections.',
    ],
  };
  return { ...body, sha256: contentHash(body) };
}
