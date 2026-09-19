import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdditiveQuestionPackage, validateQuestionPackage } from '../../scripts/release/question-package.mjs';
import { checkQuestionImportTarget } from '../../scripts/release/question-import.mjs';
import { contentHash } from '../../scripts/release/question-manifest.mjs';
import { buildQuestionPublicationPlan, validateQuestionPublicationPlan } from '../../scripts/release/question-publication.mjs';

const category={id:'00000000-0000-0000-0000-000000000001',slug:'football',name:{en:'Football'},is_active:true,campaign_only:false};
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function snapshot(project,rows){return {format:1,project,categories:[category],questions:rows.map(row=>({id:uuid(row.n),category_id:category.id,type:'mcq_single',difficulty:'easy',status:'published',prompt:{en:`Question ${row.n}`},explanation:null,ranked_eligible:true,visibility:'public',created_by:'source-author',wl_seen_count:7,...row})),payloads:rows.map(row=>({id:uuid(row.n+1000),question_id:uuid(row.n),payload:{type:'mcq_single',options:[{id:'a',text:{en:'Answer'},is_correct:true}]}}))};}

test('imports additions unpublished, retains archived/private rows and omits operational authors/history',()=>{
  const source=snapshot('stage',[{n:2},{n:3,status:'archived'},{n:4,visibility:'wl_private',ranked_eligible:false}]);
  const pkg=buildAdditiveQuestionPackage(source,snapshot('prod',[]));
  assert.deepEqual(pkg.additions.map(item=>item.question.status),['draft','archived','draft']);
  assert.ok(pkg.additions.every(item=>item.question.ranked_eligible===false&&!('created_by' in item.question)&&!('wl_seen_count' in item.question)));
  assert.equal(pkg.additions[2].question.visibility,'wl_private');
  assert.equal(pkg.additions[0].publication.status,'published');
  assert.deepEqual(pkg.additions[0].payload.payload,source.payloads[0].payload);
});

test('never turns a shared-ID production edit into an update plan',()=>{
  const source=snapshot('stage',[{n:2,prompt:{en:'Staging edit'}}]);
  const target=snapshot('prod',[{n:2,prompt:{en:'Production edit'}}]);
  const pkg=buildAdditiveQuestionPackage(source,target);
  assert.equal(pkg.additions.length,0);assert.equal(pkg.unresolvedConflicts.length,1);
  assert.deepEqual(target.questions[0].prompt,{en:'Production edit'});
});

test('maps a category slug to the existing production UUID without replacing its labels',()=>{
  const source=snapshot('stage',[{n:2}]);const target=snapshot('prod',[]);
  target.categories=[{...category,id:uuid(500),name:{en:'Production label'}}];
  const pkg=buildAdditiveQuestionPackage(source,target);
  assert.equal(pkg.categories.length,0);assert.equal(pkg.additions[0].question.category_id,uuid(500));
});

test('refuses category identity reuse and payload UUID collisions',()=>{
  const source=snapshot('stage',[{n:2}]);const target=snapshot('prod',[{n:3}]);
  target.categories=[{...category,slug:'different'}];
  assert.throws(()=>buildAdditiveQuestionPackage(source,target),/Category identity conflict/);
  target.categories=[category];target.payloads[0].id=source.payloads[0].id;
  assert.throws(()=>buildAdditiveQuestionPackage(source,target),/Payload identity collision/);
});

test('retains another-ID duplicate as unpublished and explicitly flags it for review',()=>{
  const source=snapshot('stage',[{n:2,prompt:{en:'Same'}}]);const target=snapshot('prod',[{n:3,prompt:{en:'Same'}}]);
  const pkg=buildAdditiveQuestionPackage(source,target);
  assert.deepEqual(pkg.additions[0].exactOtherIds,[uuid(3)]);
  assert.ok(pkg.additions[0].reviewReasons.includes('same-content-other-id'));
  assert.equal(pkg.additions[0].question.status,'draft');
});

test('detects package tampering and rejects a recomputed package that publishes on import',()=>{
  const pkg=buildAdditiveQuestionPackage(snapshot('stage',[{n:2}]),snapshot('prod',[]));
  validateQuestionPackage(pkg);pkg.additions[0].question.status='published';
  assert.throws(()=>validateQuestionPackage(pkg),/checksum mismatch/);
  const {sha256,...body}=pkg;pkg.sha256=contentHash(body);
  assert.throws(()=>validateQuestionPackage(pkg),/unpublished/);
});

test('refuses wrong projects, transaction pooling, ordinary local databases and misleading hostnames',()=>{
  const id='lfbwhxvwubzeqkztghok';
  for(const url of ['postgresql://postgres@127.0.0.1:5432/postgres',`postgresql://postgres.${id}@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`,`postgresql://postgres@db.${id}.supabase.co.evil.test:5432/postgres`,'postgresql://postgres.nsdfiprfmhdqhbfxfwpv@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'])assert.throws(()=>checkQuestionImportTarget(url,id,{allowLocal:true}));
  checkQuestionImportTarget(`postgresql://postgres.${id}@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`,id);
  checkQuestionImportTarget('postgresql://rehearsal@127.0.0.1:55519/rehearsal_import_test',id,{allowLocal:true});
});

test('database timestamps and their durable JSON receipt hash identically',()=>{
  const date=new Date('2026-09-19T12:00:00Z');
  assert.equal(contentHash({updated_at:date}),contentHash({updated_at:date.toISOString()}));
  assert.notEqual(contentHash({updated_at:date}),contentHash({updated_at:new Date(date.getTime()+1000)}));
});

test('approved conflict policy retains production and creates stable, separate source drafts',()=>{
  const source=snapshot('stage',[{n:2,prompt:{en:'Staging edit'},visibility:'wl_private'},{n:3}]);
  const target=snapshot('prod',[{n:2,prompt:{en:'Production edit'}}]);
  const before=structuredClone({source,target});
  const pkg=buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'});
  validateQuestionPackage(pkg);
  assert.equal(pkg.sourceOnlyIdentities,1);assert.equal(pkg.preservedConflicts.length,1);assert.equal(pkg.unresolvedConflicts.length,0);
  const draft=pkg.additions.find(item=>item.kind==='conflict-draft');
  assert.notEqual(draft.question.id,uuid(2));assert.notEqual(draft.payload.id,uuid(1002));
  assert.equal(draft.question.status,'draft');assert.equal(draft.question.visibility,'wl_private');
  assert.deepEqual(draft.question.prompt,source.questions[0].prompt);
  assert.deepEqual(draft.payload.payload,source.payloads[0].payload);
  assert.deepEqual(draft.publication,{status:'draft',ranked_eligible:false});
  assert.equal(draft.provenance.sourceQuestionId,uuid(2));
  assert.deepEqual(pkg,buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'}));
  assert.deepEqual({source,target},before);
});

test('a later source version gets a different review identity without reusing the protected target',()=>{
  const source=snapshot('stage',[{n:2,prompt:{en:'First source version'}}]);
  const target=snapshot('prod',[{n:2,prompt:{en:'Production'}}]);
  const first=buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'});
  source.questions[0].prompt={en:'Second source version'};
  const second=buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'});
  assert.notEqual(first.additions[0].question.id,second.additions[0].question.id);
  assert.equal(second.preservedConflicts[0].targetId,uuid(2));
});

test('refuses reusing a review draft identity already occupied in the target',()=>{
  const source=snapshot('stage',[{n:2,prompt:{en:'Source'}}]);
  const target=snapshot('prod',[{n:2,prompt:{en:'Production'}}]);
  const pkg=buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'});
  target.questions.push({...pkg.additions[0].question});target.payloads.push({...pkg.additions[0].payload});
  assert.throws(()=>buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'}),/identity already exists/);
});

test('conflict drafts cannot join an automatic publication plan even with a recomputed checksum',()=>{
  const pkg=buildAdditiveQuestionPackage(snapshot('stage',[{n:2,prompt:{en:'Stage'}}]),snapshot('prod',[{n:2,prompt:{en:'Prod'}}]),{conflictPolicy:'preserve-target-and-source-drafts'});
  pkg.additions[0].publication.status='published';
  const {sha256,...body}=pkg;pkg.sha256=contentHash(body);
  assert.throws(()=>validateQuestionPackage(pkg),/remain review drafts/);
});

test('publication explicitly selects eligible additions from one package and pins verification evidence',()=>{
  const pkg=buildAdditiveQuestionPackage(snapshot('stage',[{n:2},{n:3,ranked_eligible:false}]),snapshot('prod',[]));
  const plan=buildQuestionPublicationPlan(pkg,[uuid(3)],{verificationSha256:'a'.repeat(64)});
  assert.deepEqual(plan.selections,[{id:uuid(3),type:'mcq_single',rankedEligible:false}]);
  assert.deepEqual(validateQuestionPublicationPlan(plan,pkg),plan);
  assert.throws(()=>buildQuestionPublicationPlan(pkg,[uuid(2)]),/verification packet/);
  assert.throws(()=>buildQuestionPublicationPlan(pkg,[uuid(2),uuid(2)],{verificationSha256:'a'.repeat(64)}),/unique/);
});

test('publication refuses conflicts, private, archived, test-like, other-ID duplicates and unowned identities',()=>{
  const source=snapshot('stage',[{n:2},{n:3,visibility:'wl_private'},{n:4,status:'archived'},
    {n:5,prompt:{en:'E2E fixture question'}},{n:6,prompt:{en:'Same content'}},{n:7,prompt:{en:'Staging edit'}}]);
  const target=snapshot('prod',[{n:8,prompt:{en:'Same content'}},{n:7,prompt:{en:'Production edit'}}]);
  const pkg=buildAdditiveQuestionPackage(source,target,{conflictPolicy:'preserve-target-and-source-drafts'});
  for(const id of [uuid(3),uuid(4),uuid(5),uuid(6),uuid(7),uuid(8),pkg.preservedConflicts[0].draftId]) {
    assert.throws(()=>buildQuestionPublicationPlan(pkg,[id],{verificationSha256:'a'.repeat(64)}),/not eligible/);
  }
});

test('publication rejects changes to eligibility, target, verification, or package identity',()=>{
  const pkg=buildAdditiveQuestionPackage(snapshot('stage',[{n:2,ranked_eligible:false}]),snapshot('prod',[]));
  const original=buildQuestionPublicationPlan(pkg,[uuid(2)],{verificationSha256:'a'.repeat(64)});
  for(const change of [plan=>plan.selections[0].rankedEligible=true,plan=>plan.targetProject='stage',plan=>plan.packageSha256='b'.repeat(64)]) {
    const plan=structuredClone(original);change(plan);
    assert.throws(()=>validateQuestionPublicationPlan(plan,pkg),/checksum mismatch/);
    const {sha256,...body}=plan;plan.sha256=contentHash(body);
    assert.throws(()=>validateQuestionPublicationPlan(plan,pkg),/does not match/);
  }
});
