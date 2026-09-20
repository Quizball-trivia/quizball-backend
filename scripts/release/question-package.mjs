import { createHash } from 'node:crypto';
import { buildQuestionManifest, contentHash } from './question-manifest.mjs';

const QUESTION_FIELDS = ['id', 'category_id', 'type', 'difficulty', 'status', 'prompt', 'explanation', 'ranked_eligible', 'visibility'];
const CATEGORY_FIELDS = ['id', 'slug', 'parent_id', 'name', 'description', 'icon', 'image_url', 'is_active', 'campaign_only'];
const pick = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key] ?? null]));

// UUIDv5 in the standard URL namespace. Rebuilding an unchanged package must
// preserve each review draft's identity; a different source version gets its own.
function reviewUuid(project, originalId, sourceHash, kind) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const name = `https://quizball.io/content-releases/${project}/${originalId}/${sourceHash}/${kind}`;
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Pure compiler: every source-only identity is retained, initially unpublished.
 * Existing target records are never part of an UPDATE plan. Conflicts remain
 * explicit review items; this compiler cannot choose their winning version.
 */
export function buildAdditiveQuestionPackage(source, target, { conflictPolicy = 'hold' } = {}) {
  if (!['hold', 'preserve-target-and-source-drafts'].includes(conflictPolicy)) throw new Error('Unknown question conflict policy');
  const manifest = buildQuestionManifest(source, target);
  const sourceQuestions = new Map(source.questions.map(row => [row.id, row]));
  const sourcePayloads = new Map(source.payloads.map(row => [row.question_id, row]));
  const targetPayloadIds = new Set(target.payloads.map(row => row.id));
  const targetCategoriesById = new Map(target.categories.map(row => [row.id, row]));
  const targetCategoriesBySlug = new Map(target.categories.map(row => [row.slug, row]));
  const categoryIds = new Map();
  const categories = [];
  for (const category of source.categories) {
    const existingId = targetCategoriesById.get(category.id);
    const existingSlug = targetCategoriesBySlug.get(category.slug);
    if (existingId && existingId.slug !== category.slug) throw new Error(`Category identity conflict: ${category.id}`);
    const id = existingId?.id ?? existingSlug?.id ?? category.id;
    categoryIds.set(category.id, id);
    if (!existingId && !existingSlug) categories.push(pick(category, CATEGORY_FIELDS));
  }
  for (const category of categories) {
    if (category.parent_id) {
      const parent = categoryIds.get(category.parent_id);
      if (!parent) throw new Error('Unresolved category parent');
      category.parent_id = parent;
    }
  }
  const conflicts = manifest.entries.filter(entry => entry.disposition === 'preserve-target-review-conflict');
  const selected = manifest.entries.filter(entry => !entry.targetId || (conflictPolicy === 'preserve-target-and-source-drafts' && entry.disposition === 'preserve-target-review-conflict'));
  const occupiedQuestionIds = new Set([...source.questions, ...target.questions].map(row => row.id));
  const occupiedPayloadIds = new Set([...source.payloads, ...target.payloads].map(row => row.id));
  const preservedConflicts = [];
  const additions = selected.map(entry => {
    const sourceQuestion = sourceQuestions.get(entry.sourceId);
    const sourcePayload = sourcePayloads.get(entry.sourceId);
    const conflict = Boolean(entry.targetId);
    if (!conflict && targetPayloadIds.has(sourcePayload.id)) throw new Error(`Payload identity collision: ${sourcePayload.id}`);
    const question = pick(sourceQuestion, QUESTION_FIELDS);
    let payloadId = sourcePayload.id;
    if (conflict) {
      question.id = reviewUuid(source.project, entry.sourceId, entry.sourceHash, 'question');
      payloadId = reviewUuid(source.project, entry.sourceId, entry.sourceHash, 'payload');
      if (occupiedQuestionIds.has(question.id) || occupiedPayloadIds.has(payloadId)) throw new Error('Review draft identity already exists; refresh the conflict manifest');
      occupiedQuestionIds.add(question.id); occupiedPayloadIds.add(payloadId);
      preservedConflicts.push({ sourceId: entry.sourceId, targetId: entry.targetId, draftId: question.id, sourceHash: entry.sourceHash, targetHash: entry.targetHash, changedPaths: entry.changedPaths });
    }
    question.category_id = categoryIds.get(sourceQuestion.category_id);
    const originalStatus = question.status;
    // Retain archived/draft rows as such. Published rows first enter as drafts;
    // publishing is a separate, explicitly selected operation after code tests.
    question.status = conflict || originalStatus === 'published' ? 'draft' : originalStatus;
    question.ranked_eligible = false;
    return {
      kind: conflict ? 'conflict-draft' : 'source-only',
      provenance: { sourceQuestionId: entry.sourceId, sourcePayloadId: sourcePayload.id, sourceHash: entry.sourceHash, originalStatus, originalRankedEligible: sourceQuestion.ranked_eligible },
      question,
      payload: { id: payloadId, question_id: question.id, payload: sourcePayload.payload },
      publication: conflict ? { status: 'draft', ranked_eligible: false } : { status: originalStatus, ranked_eligible: sourceQuestion.ranked_eligible },
      reviewReasons: [...entry.reviewReasons, ...(conflict ? ['preserved-conflict-draft'] : []), ...(entry.exactOtherIds.length ? ['same-content-other-id'] : [])],
      exactOtherIds: entry.exactOtherIds,
    };
  });
  const body = {
    format: 2,
    conflictPolicy,
    sourceProject: source.project,
    targetProject: target.project,
    sourceSnapshotHash: manifest.sourceSnapshotHash,
    targetSnapshotHash: manifest.targetSnapshotHash,
    categories,
    // Only category identity/slug are prerequisites. Production descriptions and
    // author/history columns are neither imported nor overwritten.
    categoryPrerequisites: target.categories.map(row => ({ id: row.id, slug: row.slug })),
    additions,
    preservedConflicts,
    unresolvedConflicts: conflictPolicy === 'hold' ? conflicts.map(entry => ({ id: entry.sourceId, sourceHash: entry.sourceHash, targetHash: entry.targetHash, changedPaths: entry.changedPaths })) : [],
    sourceOnlyIdentities: additions.filter(item => item.kind === 'source-only').length,
  };
  return { ...body, sha256: contentHash(body) };
}

export function validateQuestionPackage(pkg) {
  const { sha256, ...body } = pkg;
  if (![1, 2].includes(pkg.format) || !/^[a-f0-9]{64}$/.test(sha256 ?? '') || contentHash(body) !== sha256) throw new Error('Question package checksum mismatch');
  if (!pkg.sourceProject || !pkg.targetProject || pkg.sourceProject === pkg.targetProject) throw new Error('Invalid project pair');
  const seen = new Set(), payloadIds = new Set();
  const preserved = pkg.preservedConflicts ?? [];
  const conflictsByDraft = new Map(preserved.map(item => [item.draftId, item]));
  const protectedIds = new Set(preserved.map(item => item.targetId));
  for (const item of pkg.additions) {
    if (seen.has(item.question.id) || protectedIds.has(item.question.id) || payloadIds.has(item.payload.id) || item.payload.question_id !== item.question.id) throw new Error('Invalid question identity');
    seen.add(item.question.id);
    payloadIds.add(item.payload.id);
    if (item.question.status === 'published' || item.question.ranked_eligible !== false) throw new Error('Import must be unpublished and ineligible for ranked');
    if (item.kind === 'conflict-draft' && (!conflictsByDraft.has(item.question.id) || item.question.status !== 'draft' || item.publication.status !== 'draft' || item.publication.ranked_eligible !== false)) throw new Error('Preserved conflicts must remain review drafts');
  }
  if (seen.size !== pkg.sourceOnlyIdentities + preserved.length || preserved.length !== pkg.additions.filter(item => item.kind === 'conflict-draft').length) throw new Error('Question package count mismatch');
  return pkg;
}
