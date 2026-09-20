import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStagingQuestionAlignmentPlan } from '../../scripts/release/question-alignment-plan.mjs';
import { buildAdditiveQuestionPackage, validateQuestionPackage } from '../../scripts/release/question-package.mjs';
import { contentHash } from '../../scripts/release/question-manifest.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const category = { id: id(1), slug: 'football', name: { en: 'Football' }, is_active: true, campaign_only: false };
const snapshot = (project, rows) => ({ format: 1, project, categories: [category],
  questions: rows.map(row => ({ id: id(row.n), category_id: category.id, type: 'mcq_single', difficulty: 'easy',
    status: 'published', prompt: { en: `Question ${row.n}` }, explanation: null, ranked_eligible: true,
    visibility: 'public', created_by: 'local-editor', wl_seen_count: 11, ...row })),
  payloads: rows.map(row => ({ id: id(row.n + (project === 'stage' ? 1000 : 2000)), question_id: id(row.n), payload: { answer: row.n } })) });
const compile = (stage, prod) => buildStagingQuestionAlignmentPlan(stage, prod,
  buildAdditiveQuestionPackage(stage, prod, { conflictPolicy: 'preserve-target-and-source-drafts' }));

test('preserves both environments, reuses conflict draft identities and retains local payload/history identities', () => {
  const stage = snapshot('stage', [{ n: 2, prompt: { en: 'Stage edit' } }, { n: 3 }, { n: 5 }]);
  const prod = snapshot('prod', [{ n: 2, prompt: { en: 'Prod edit' } }, { n: 4 }, { n: 5 }]);
  const original = structuredClone({ stage, prod });
  const plan = compile(stage, prod);
  assert.equal(plan.executable, false);
  assert.equal(plan.unchangedShared, 1);
  assert.deepEqual(plan.stagingOnlyRetained, [id(3)]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.preservation.additions.length, 2);
  assert.equal(plan.preservation.sourceOnlyIdentities, 1);
  validateQuestionPackage(plan.preservation);
  const draft = plan.preservation.additions.find(row => row.kind === 'conflict-draft');
  assert.equal(draft.question.id, plan.updates[0].draftId);
  assert.deepEqual(draft.question.prompt, { en: 'Stage edit' });
  assert.deepEqual(plan.updates[0].after.question.prompt, { en: 'Prod edit' });
  assert.equal(plan.updates[0].after.payloadId, stage.payloads[0].id);
  assert.equal(plan.updates[0].beforeHash, contentHash(plan.updates[0].baseline));
  assert.ok(plan.preservation.additions.every(row => row.question.status === 'draft' && !row.question.ranked_eligible));
  for (const key of ['created_by', 'wl_seen_count', 'updated_at']) assert.equal(key in plan.updates[0].after.question, false);
  assert.deepEqual({ stage, prod }, original);
  assert.deepEqual(plan, compile(stage, prod));
});

test('maps production category UUIDs by slug and keeps the staging-only conflict category in its draft', () => {
  const stage = snapshot('stage', [{ n: 2 }]);
  const prod = snapshot('prod', [{ n: 2, prompt: { en: 'Winner' } }, { n: 3 }]);
  prod.categories = [{ ...category, id: id(600) }];
  prod.questions.forEach(row => { row.category_id = id(600); });
  stage.categories.push({ ...category, id: id(601), slug: 'new-mode' });
  stage.questions[0].category_id = id(601);
  const plan = compile(stage, prod);
  assert.equal(plan.updates[0].after.question.category_id, category.id);
  assert.equal(plan.preservation.additions.find(row => row.kind === 'conflict-draft').question.category_id, id(601));
  assert.equal(plan.preservation.additions.find(row => row.kind === 'source-only').question.category_id, category.id);
});

test('requires exact source snapshots and source-backed preservation content even after checksum recomputation', () => {
  const stage = snapshot('stage', [{ n: 2, prompt: { en: 'Stage' } }]);
  const prod = snapshot('prod', [{ n: 2, prompt: { en: 'Prod' } }]);
  const pkg = buildAdditiveQuestionPackage(stage, prod, { conflictPolicy: 'preserve-target-and-source-drafts' });
  const changed = structuredClone(stage); changed.questions[0].prompt.en = 'Later edit';
  assert.throws(() => buildStagingQuestionAlignmentPlan(changed, prod, pkg), /exact approved/);
  const tampered = structuredClone(pkg); tampered.additions[0].payload.payload = { answer: 'wrong' };
  const { sha256, ...body } = tampered; tampered.sha256 = contentHash(body);
  assert.throws(() => buildStagingQuestionAlignmentPlan(stage, prod, tampered), /source content/);
});

test('carries production-only private rows as private drafts without altering staging-only content', () => {
  const plan = compile(snapshot('stage', [{ n: 2, visibility: 'wl_private' }]),
    snapshot('prod', [{ n: 3, visibility: 'wl_private', ranked_eligible: false }]));
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.stagingOnlyRetained, [id(2)]);
  assert.equal(plan.preservation.additions[0].question.visibility, 'wl_private');
  assert.equal(plan.preservation.additions[0].question.status, 'draft');
  assert.ok(plan.gates.some(gate => gate.includes('event/history')));
});
