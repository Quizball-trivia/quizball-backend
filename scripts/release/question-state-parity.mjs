import postgres from 'postgres';
import {contentHash} from './question-manifest.mjs';
import {validateAlignmentInput} from './staging-question-alignment.mjs';
import {validateQuestionPackage} from './question-package.mjs';
import {validateQuestionPublicationPlan} from './question-publication.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
const STAGING='nsdfiprfmhdqhbfxfwpv',PRODUCTION='lfbwhxvwubzeqkztghok';
const FIELDS=['category_id','type','difficulty','status','prompt','explanation','ranked_eligible','visibility'];
const pick=q=>Object.fromEntries(FIELDS.map(k=>[k,q[k]??null]));
const state=q=>({status:q.status,ranked_eligible:q.ranked_eligible});
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

/** Compile the final question states after preservation, semantic alignment,
 * and explicitly reviewed publication. No content or visibility is rewritten.
 */
export function buildStagingQuestionStatePlan(staging,production,promotion,alignment,publications,{verificationSha256}={}){
 validateQuestionPackage(promotion);validateAlignmentInput(alignment,alignment.sha256);
 if(!digest(verificationSha256)||staging.project!==STAGING||production.project!==PRODUCTION
  ||contentHash(staging)!==alignment.stagingSnapshotHash||contentHash(production)!==alignment.productionSnapshotHash
  ||promotion.sha256!==alignment.promotionPackageSha256)throw new Error('Exact reviewed snapshots and publication verification required');
 const target=new Map(production.questions.map(q=>[q.id,state(q)]));
 for(const item of promotion.additions)target.set(item.question.id,state(item.question));
 const selected=new Set();
 for(const input of publications){const publication=validateQuestionPublicationPlan(input,promotion);
  for(const row of publication.selections){if(selected.has(row.id))throw new Error('Duplicate publication selection');selected.add(row.id);target.set(row.id,{status:'published',ranked_eligible:row.rankedEligible});}
 }
 const questions=new Map(staging.questions.map(q=>[q.id,pick(q)]));
 const payloads=new Map(staging.payloads.map(p=>[p.question_id,{id:p.id,payload:p.payload}]));
 for(const item of alignment.preservation.additions){if(questions.has(item.question.id))throw new Error('Preservation identity collision');questions.set(item.question.id,pick(item.question));payloads.set(item.question.id,{id:item.payload.id,payload:item.payload.payload});}
 for(const row of alignment.updates){questions.set(row.id,row.after.question);payloads.set(row.id,{id:row.after.payloadId,payload:row.after.payload});}
 if(questions.size!==target.size||[...questions.keys()].some(id=>!target.has(id)))throw new Error('Preserved question identity sets differ');
 const rows=[];
 for(const [id,question] of questions){const after=target.get(id);if(same(state(question),after))continue;
  const payload=payloads.get(id);if(!payload)throw new Error('Missing question payload');
  rows.push({id,before:question,payloadId:payload.id,payloadSha256:contentHash(payload.payload),after});
 }
 rows.sort((a,b)=>a.id.localeCompare(b.id));
 const body={format:1,sourceProject:PRODUCTION,targetProject:STAGING,operation:'staging-question-state-parity',
  productionSnapshotHash:contentHash(production),stagingSnapshotHash:contentHash(staging),promotionPackageSha256:promotion.sha256,
  preservationPackageSha256:alignment.preservation.sha256,preservationQuestionCount:alignment.preservation.additions.length,alignmentSha256:alignment.sha256,alignmentQuestionCount:alignment.updates.length,
  publicationPlanHashes:publications.map(p=>p.sha256).sort(),verificationSha256,
  canonicalStateSha256:contentHash([...target].sort(([a],[b])=>a.localeCompare(b))),retainedQuestionCount:questions.size,rows};
 return {...body,sha256:contentHash(body)};
}
export function validateQuestionStatePlan(plan,expectedSha256){
 const {sha256,...body}=plan;
 if(!digest(expectedSha256)||sha256!==expectedSha256||contentHash(body)!==sha256||plan.format!==1
  ||plan.operation!=='staging-question-state-parity'||plan.sourceProject!==PRODUCTION||plan.targetProject!==STAGING
  ||!['productionSnapshotHash','stagingSnapshotHash','promotionPackageSha256','preservationPackageSha256','alignmentSha256','verificationSha256','canonicalStateSha256'].every(k=>digest(plan[k]))
  ||!Array.isArray(plan.publicationPlanHashes)||!plan.publicationPlanHashes.every(digest)
  ||![plan.alignmentQuestionCount,plan.preservationQuestionCount,plan.retainedQuestionCount].every(n=>Number.isSafeInteger(n)&&n>=0)
  ||plan.retainedQuestionCount<plan.rows.length)throw new Error('Pinned staging question-state plan required');
 const ids=new Set();
 for(const row of plan.rows){
  if(!/^[a-f0-9-]{36}$/.test(row.id)||ids.has(row.id)||!digest(row.payloadSha256)||!row.payloadId
   ||Object.keys(row.before).sort().join(',')!==[...FIELDS].sort().join(',')
   ||Object.keys(row.after).sort().join(',')!=='ranked_eligible,status'
   ||!['draft','published','archived'].includes(row.after.status)||typeof row.after.ranked_eligible!=='boolean'
   ||same(state(row.before),row.after))throw new Error('Invalid state-only change');
  ids.add(row.id);
 }
 return plan;
}

/** Staging-only, one transaction. Apply after preservation and semantic alignment,
 * before media/campaign bindings. Full before/after receipts protect later edits.
 */
export async function runStagingQuestionStateParity({databaseUrl,plan:input,expectedSha256,action='dry-run',rehearsal=false,evidence={}}){
 const plan=validateQuestionStatePlan(input,expectedSha256);
 if(!['dry-run','apply','undo','undo-dry-run'].includes(action))throw new Error('Unknown question-state action');
 const url=new URL(databaseUrl);
 if(rehearsal&&(url.hostname!=='127.0.0.1'||url.port!=='55519'||!/^\/rehearsal_[a-z0-9_]+$/.test(url.pathname)))throw new Error('Isolated rehearsal connection required');
  checkQuestionImportTarget(databaseUrl,STAGING,{allowLocal:rehearsal});
 if(!rehearsal&&!['require','verify-full','verify-ca'].includes(url.searchParams.get('sslmode')))throw new Error('Encrypted staging connection required');
 const dryRun=action.endsWith('dry-run'),undo=action.startsWith('undo');
 if(!dryRun&&!rehearsal&&(!evidence.fullStagingRestoreVerified||!evidence.runtimeDrained||!['backupSha256','reservationSha256','rehearsalSha256'].every(k=>digest(evidence[k]))))throw new Error('Staging recovery and rehearsal evidence required');
 const sql=postgres(databaseUrl,{max:1,prepare:false,onnotice:()=>{}});
 try{return await sql.begin(dryRun?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
  await tx`SET LOCAL timezone='UTC'`;await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
  if(!dryRun){await tx`SELECT pg_advisory_xact_lock(20260919,33342)`;await tx`LOCK TABLE questions,question_payloads IN SHARE ROW EXCLUSIVE MODE`;}
  const [alignment]=await tx`SELECT preservation_map FROM question_release_batches WHERE id=${plan.alignmentSha256}`;
  const [aligned]=await tx`SELECT count(*)::int n FROM question_release_rows WHERE batch_id=${plan.alignmentSha256} AND phase='align'`;
  const [alignmentUndo]=await tx`SELECT count(*)::int n FROM question_release_rows WHERE batch_id=${plan.alignmentSha256} AND phase='undo'`;
  if(!undo&&plan.alignmentQuestionCount&&(!alignment||alignment.preservation_map?.operation!=='production-canonical-staging-alignment'||aligned.n!==plan.alignmentQuestionCount*2||alignmentUndo.n))throw new Error('Semantic alignment must be complete and not undone');
  const [preserved]=await tx`SELECT count(*)::int n FROM question_release_rows r JOIN questions q ON q.id=r.row_id WHERE r.batch_id=${plan.preservationPackageSha256} AND r.table_name='questions' AND r.phase='import'`;
  if(!undo&&preserved.n!==plan.preservationQuestionCount)throw new Error('Complete staging question preservation required');
  const [batch]=await tx`SELECT * FROM question_release_batches WHERE id=${plan.sha256}`;
  if(batch&&(batch.source_project!==PRODUCTION||batch.target_project!==STAGING||batch.manifest_sha256!==plan.sha256||batch.preservation_map?.operation!==plan.operation||batch.preservation_map?.canonicalStateSha256!==plan.canonicalStateSha256||batch.preservation_map?.alignmentSha256!==plan.alignmentSha256))throw new Error('State parity batch metadata differs');
  const receipts=await tx`SELECT * FROM question_release_rows WHERE batch_id=${plan.sha256}`;
  const applied=new Map(receipts.filter(r=>r.phase==='align'&&r.table_name==='questions').map(r=>[r.row_id,r]));
  const undone=new Map(receipts.filter(r=>r.phase==='undo'&&r.table_name==='questions').map(r=>[r.row_id,r]));
  if(applied.size&&(!batch||applied.size!==plan.rows.length))throw new Error('Partial state parity receipts');
  if(undo&&!applied.size)throw new Error('No completed state parity to undo');
  if(!undo&&undone.size)throw new Error('Undone state parity cannot be reapplied');
  const ids=plan.rows.map(r=>r.id);
  const current=new Map((await tx`SELECT to_jsonb(q) AS question,to_jsonb(p) AS payload FROM questions q JOIN question_payloads p ON p.question_id=q.id WHERE q.id=ANY(${tx.array(ids)}::uuid[])`).map(r=>[r.question.id,r]));
  const report={planSha256:plan.sha256,action,dryRun,changed:0,resumed:0,needsReview:[],deletedRows:0};
  const changes=[];
  for(const row of plan.rows){const from=current.get(row.id),prior=applied.get(row.id);
   const payloadMatches=from?.payload.id===row.payloadId&&contentHash(from.payload.payload)===row.payloadSha256;
   if(undo){if(undone.has(row.id)){report.resumed++;continue;}if(!same(from?.question,prior?.after_data)||!payloadMatches){report.needsReview.push(row.id);continue;}changes.push({id:row.id,from:from.question,to:state(prior.before_data)});}
   else if(prior){if(!same(from?.question,prior.after_data)||!payloadMatches)throw new Error('Question state was edited after alignment');report.resumed++;}
   else{if(!from||!same(pick(from.question),row.before)||from.payload.id!==row.payloadId||contentHash(from.payload.payload)!==row.payloadSha256)throw new Error('Question or payload changed since state review');changes.push({id:row.id,from:from.question,to:row.after});}
  }
  report.planned=changes.length;if(dryRun||!changes.length)return report;
  await tx`SELECT set_config('quizball.campaign_quiz_write','on',true)`;
  if(!undo)await tx`INSERT INTO question_release_batches(id,source_project,target_project,manifest_sha256,preservation_map)
   VALUES(${plan.sha256},${PRODUCTION},${STAGING},${plan.sha256},${tx.json({operation:plan.operation,canonicalStateSha256:plan.canonicalStateSha256,alignmentSha256:plan.alignmentSha256,evidence,rehearsal})})`;
  for(let i=0;i<changes.length;i+=100){const chunk=changes.slice(i,i+100),byId=new Map(chunk.map(r=>[r.id,r]));
   const updated=await tx`UPDATE questions q SET status=s.status,ranked_eligible=s.ranked_eligible
    FROM jsonb_populate_recordset(NULL::questions,${tx.json(chunk.map(r=>({id:r.id,...r.to})))}) s WHERE q.id=s.id RETURNING to_jsonb(q) AS row`;
   if(updated.length!==chunk.length)throw new Error('State parity update count differs');
   for(const {row} of updated){const expected={...byId.get(row.id).from,...byId.get(row.id).to},actual={...row};delete expected.updated_at;delete actual.updated_at;if(!same(expected,actual))throw new Error('State update changed unrelated content');}
   await tx`INSERT INTO question_release_rows ${tx(updated.map(({row})=>({batch_id:plan.sha256,table_name:'questions',row_id:row.id,phase:undo?'undo':'align',before_data:tx.json(byId.get(row.id).from),after_data:tx.json(row)})))}`;
   report.changed+=updated.length;
  }
  return report;
 });}finally{await sql.end({timeout:5});}
}
