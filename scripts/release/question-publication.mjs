import { contentHash } from './question-manifest.mjs';
import { validateQuestionPackage } from './question-package.mjs';

const isSha = value => /^[a-f0-9]{64}$/.test(value ?? '');

// Publication always names individual IDs from one immutable import package.
// Media, references, mode and locale verification are supplied by the release
// packet; a checksum identifies that evidence, it does not replace the checks.
export function buildQuestionPublicationPlan(input, questionIds, { verificationSha256, publicationScope = 'public' } = {}) {
  const pkg = validateQuestionPackage(input);
  if (!isSha(verificationSha256)) throw new Error('A pinned verification packet is required');
  if (!['public', 'wl-private'].includes(publicationScope)) throw new Error('Unknown question publication scope');
  if (!Array.isArray(questionIds) || !questionIds.length || new Set(questionIds).size !== questionIds.length) throw new Error('Select a nonempty, unique list of question IDs');
  const byId = new Map(pkg.additions.map(item => [item.question.id, item]));
  const selections = [...questionIds].sort().map(id => {
    const item = byId.get(id);
    // Existing WL pool content is reviewed separately from public questions.
    // It keeps its private visibility and cannot become ranked content. A
    // visibility flag alone is the only review reason this scope resolves.
    const scopeEligible = publicationScope === 'wl-private'
      ? item?.question.visibility === 'wl_private' && item.publication.ranked_eligible === false
        && item.reviewReasons.length === 1 && item.reviewReasons[0] === 'visibility:wl_private'
      : item?.question.visibility === 'public' && !item.reviewReasons.length;
    if (!item || (item.kind && item.kind !== 'source-only') || item.question.status !== 'draft'
        || !scopeEligible || item.publication.status !== 'published' || item.exactOtherIds.length) {
      throw new Error(`Question is not eligible for release publication: ${id}`);
    }
    return { id, type: item.question.type, rankedEligible: item.publication.ranked_eligible };
  });
  const body = { format: 1, packageSha256: pkg.sha256, targetProject: pkg.targetProject, verificationSha256, selections };
  if (publicationScope === 'wl-private') Object.assign(body, { format: 2, publicationScope });
  return { ...body, sha256: contentHash(body) };
}

export function validateQuestionPublicationPlan(input, pkg) {
  const { sha256, ...body } = input;
  if (!isSha(sha256) || contentHash(body) !== sha256) throw new Error('Publication plan checksum mismatch');
  const expected = buildQuestionPublicationPlan(pkg, input.selections.map(row => row.id), {
    verificationSha256: input.verificationSha256, publicationScope: input.publicationScope ?? 'public',
  });
  if (sha256 !== expected.sha256) throw new Error('Publication plan does not match its import package');
  return expected;
}
