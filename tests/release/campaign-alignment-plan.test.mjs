import test from 'node:test';import assert from 'node:assert/strict';
import {buildCampaignAlignmentPlan} from '../../scripts/release/campaign-alignment-plan.mjs';
const options={stagingSnapshotSha256:'a'.repeat(64),productionSnapshotSha256:'b'.repeat(64),questionStatePlanSha256:'c'.repeat(64)};
const fixture=(token,question_id)=>({campaign_quizzes:[{slug:'team',title:'Football',status:'published',preview_token:token,created_by:token,created_at:'local-time',updated_at:'local-time'}],campaign_quiz_questions:[{quiz_slug:'team',question_id,difficulty:'easy',display_order:1,created_at:'local-time'}],campaign_quiz_manual_questions:[],campaign_quiz_related_pages:[],campaign_quiz_routes:[],campaign_quiz_revisions:[{id:1}]});
test('retains production selection and source graph without copying secrets/authors or changing questions',()=>{const stage=fixture('stage-secret','stage-question'),prod=fixture('prod-secret','prod-question'),before=structuredClone({stage,prod});const p=buildCampaignAlignmentPlan(stage,prod,options);assert.deepEqual({stage,prod},before);assert.equal(p.tables.campaign_quiz_questions.before[0].question_id,'stage-question');assert.equal(p.tables.campaign_quiz_questions.after[0].question_id,'prod-question');assert.equal(p.pages[0].after.preview_token,undefined);assert.equal(p.pages[0].after.created_by,undefined);assert.ok(p.preservedTables.includes('questions'));assert.equal(p.stagingRevisionCount,1);assert.equal(p.executable,false);});
test('refuses missing tables, duplicate relations, new pages and unreviewed redirects',()=>{for(const mutate of [s=>delete s.campaign_quiz_questions,s=>s.campaign_quiz_questions.push({...s.campaign_quiz_questions[0]}),s=>s.campaign_quizzes.push({...s.campaign_quizzes[0],slug:'new-page'}),s=>s.campaign_quiz_routes.push({slug:'old-route'})]){const stage=fixture('stage','question');mutate(stage);assert.throws(()=>buildCampaignAlignmentPlan(stage,fixture('prod','question'),options),/snapshots|required|identity|review/);}});

test('executor validation refuses rehashed protected-field and target changes',async()=>{
 const {validateCampaignAlignmentPlan}=await import('../../scripts/release/campaign-alignment.mjs');
 const {contentHash}=await import('../../scripts/release/question-manifest.mjs');
 for(const mutate of [p=>p.pages[0].after.preview_token='copied-secret',p=>p.targetProject='lfbwhxvwubzeqkztghok',p=>p.tables.campaign_quiz_questions.after[0].created_at='copied-time']){
  const p=buildCampaignAlignmentPlan(fixture('stage','stage-question'),fixture('prod','prod-question'),options);mutate(p);const{sha256,...body}=p;p.sha256=contentHash(body);
  assert.throws(()=>validateCampaignAlignmentPlan(p,p.sha256),/scope or protected|columns differ/);
 }
});
test('executor refuses production or absent cloud recovery before connecting',async()=>{
 const {runCampaignAlignment}=await import('../../scripts/release/campaign-alignment.mjs');
 const plan=buildCampaignAlignmentPlan(fixture('stage','stage-question'),fixture('prod','prod-question'),options);
 await assert.rejects(runCampaignAlignment({databaseUrl:'postgresql://postgres@db.lfbwhxvwubzeqkztghok.supabase.co:5432/postgres?sslmode=require',plan,expectedSha256:plan.sha256,action:'apply'}),/exact direct\/session/);
 await assert.rejects(runCampaignAlignment({databaseUrl:'postgresql://postgres@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres?sslmode=require',plan,expectedSha256:plan.sha256,action:'apply'}),/recovery, reservation and rehearsal/);
});
