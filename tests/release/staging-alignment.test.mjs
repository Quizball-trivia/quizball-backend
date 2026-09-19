import test from 'node:test';
import assert from 'node:assert/strict';
import {contentHash} from '../../scripts/release/question-manifest.mjs';
import {buildAdditiveQuestionPackage} from '../../scripts/release/question-package.mjs';
import {buildStagingQuestionAlignmentPlan} from '../../scripts/release/question-alignment-plan.mjs';
import {validateAlignmentInput,runStagingQuestionAlignment} from '../../scripts/release/staging-question-alignment.mjs';
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function fixture(){
 const snapshot=(project,prompt)=>({format:1,project,categories:[{id:id(1),slug:'football',name:{en:'Football'},is_active:true,campaign_only:false}],
 questions:[{id:id(2),category_id:id(1),type:'mcq_single',difficulty:'easy',status:'published',prompt:{en:prompt},explanation:null,ranked_eligible:true,visibility:'public'}],
 payloads:[{id:id(3),question_id:id(2),payload:{options:['a','b','c','d'],correct_index:0}}]});
 const stage=snapshot('nsdfiprfmhdqhbfxfwpv','Stage'),prod=snapshot('lfbwhxvwubzeqkztghok','Production');
 return buildStagingQuestionAlignmentPlan(stage,prod,buildAdditiveQuestionPackage(stage,prod,{conflictPolicy:'preserve-target-and-source-drafts'}));
}
const resign=plan=>{const {sha256,...body}=plan;plan.sha256=contentHash(body);return plan;};
test('accepts a pinned source-backed plan and rejects checksum or target substitution',()=>{
 const plan=fixture();assert.equal(validateAlignmentInput(plan,plan.sha256),plan);
 assert.throws(()=>validateAlignmentInput(plan,'f'.repeat(64)),/pinned/);
 const changed=structuredClone(plan);changed.updates[0].after.question.prompt.en='Unreviewed';assert.throws(()=>validateAlignmentInput(changed,plan.sha256),/pinned/);
 changed.targetProject='lfbwhxvwubzeqkztghok';resign(changed);assert.throws(()=>validateAlignmentInput(changed,changed.sha256),/pinned/);
});
test('rejects operational-field writes, payload identity changes, and duplicate updates',()=>{
 for(const mutate of [p=>p.updates[0].after.question.created_by=id(4),p=>p.updates[0].after.payloadId=id(9),p=>p.updates.push(structuredClone(p.updates[0]))]){
  const plan=fixture();mutate(plan);resign(plan);assert.throws(()=>validateAlignmentInput(plan,plan.sha256),/identity or baseline/);
 }
});
test('requires a matching preserved draft even when the entire package is rehashed',()=>{
 const plan=fixture();plan.preservation.additions[0].payload.payload.correct_index=2;
 resign(plan.preservation);resign(plan);assert.throws(()=>validateAlignmentInput(plan,plan.sha256),/Draft does not preserve/);
});
test('refuses production, wrong local services, and missing recovery evidence before opening connections',async()=>{
 const plan=fixture();
 for(const [databaseUrl,rehearsal] of [
  ['postgresql://postgres@db.lfbwhxvwubzeqkztghok.supabase.co:5432/postgres',false],
  ['postgresql://postgres@127.0.0.1:5432/rehearsal_test',true],
  ['postgresql://postgres@127.0.0.1:55519/postgres',true],
  ['postgresql://postgres@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres',true],
 ])await assert.rejects(runStagingQuestionAlignment({databaseUrl,rehearsal,plan,expectedPlanSha256:plan.sha256,action:'apply'}),/target|rehearsal connection/);
 await assert.rejects(runStagingQuestionAlignment({databaseUrl:'postgresql://postgres@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres',plan,expectedPlanSha256:plan.sha256,action:'apply'}),/preservation and runtime reservation/);
});
