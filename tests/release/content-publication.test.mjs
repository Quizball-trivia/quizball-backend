import test from'node:test';import assert from'node:assert/strict';import{contentHash}from'../../scripts/release/question-manifest.mjs';
import{buildContentPublicationPlan,validateContentPublicationPlan,publishReleaseContent}from'../../scripts/release/content-publication.mjs';
const id='00000000-0000-4000-8000-000000000001',batch='1'.repeat(64),verificationSha256='2'.repeat(64);
const row=()=>({table:'fifa_cards',contentBatchId:batch,before:{id,is_active:false,name:'Preserved'},publication:{is_active:true}});
test('publication changes only selected activation fields and has a retaining rollback',()=>{
 const p=buildContentPublicationPlan([row()],{verificationSha256});validateContentPublicationPlan(p,p.sha256);assert.equal(p.rows[0].after.name,'Preserved');assert.deepEqual(p.rows[0].rollback,{is_active:false});
 p.rows[0].after.name='Changed';const{sha256,...body}=p;p.sha256=contentHash(body);assert.throws(()=>validateContentPublicationPlan(p,p.sha256),/outside/);
});
test('published Grid needs original approvals and rolls back by retiring',()=>{
 const r={table:'football_grid_content_releases',contentBatchId:batch,before:{id,status:'draft',approved_by:null,approved_at:null,published_at:null},publication:{status:'published',approved_by:'existing-source-reviewer',approved_at:'2026-09-01T00:00:00Z',published_at:'2026-09-02T00:00:00Z'}};
 assert.deepEqual(buildContentPublicationPlan([r],{verificationSha256}).rows[0].rollback,{status:'retired'});
 r.publication.approved_by=null;assert.throws(()=>buildContentPublicationPlan([r],{verificationSha256}),/approval/);
});
test('rejects unselected fields, duplicate rows and unsafe reactivation',()=>{
 assert.throws(()=>buildContentPublicationPlan([{...row(),publication:{is_active:true,name:'Changed'}}],{verificationSha256}),/scope/);
 assert.throws(()=>buildContentPublicationPlan([row(),row()],{verificationSha256}),/Duplicate/);
 const r=row();r.before.is_active=true;assert.throws(()=>buildContentPublicationPlan([r],{verificationSha256}),/inactive/);
});
test('rollback stops before connecting unless dependent modes are disabled',async()=>{
 const p=buildContentPublicationPlan([row()],{verificationSha256});await assert.rejects(publishReleaseContent(null,p,{expectedSha256:p.sha256,dryRun:false,undo:true}),/Disable dependent/);
});
