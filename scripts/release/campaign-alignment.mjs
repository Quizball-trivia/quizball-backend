import postgres from 'postgres';
import {contentHash} from './question-manifest.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
import {buildCampaignAlignmentPlan} from './campaign-alignment-plan.mjs';
const STAGING='nsdfiprfmhdqhbfxfwpv',PROD='lfbwhxvwubzeqkztghok';
const RELATIONS={campaign_quiz_questions:['quiz_slug','question_id','difficulty','display_order'],campaign_quiz_manual_questions:['quiz_slug','question_id'],campaign_quiz_related_pages:['quiz_slug','related_slug','display_order']};
const LOCAL_FIELDS=new Set(['created_at','updated_at','created_by','updated_by','preview_token']);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);
const identity=(table,row)=>table==='campaign_quizzes'?row.slug:row.quiz_slug+':'+(row.question_id??row.related_slug);
const sorted=(table,rows)=>rows.sort((a,b)=>identity(table,a).localeCompare(identity(table,b)));
const editorial=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!LOCAL_FIELDS.has(k)));
const relations=(table,rows)=>sorted(table,rows.map(r=>Object.fromEntries(RELATIONS[table].map(k=>[k,r[k]]))));
export function validateCampaignAlignmentPlan(plan,expectedSha256){
 const{sha256,...body}=plan;
 if(!digest(expectedSha256)||sha256!==expectedSha256||contentHash(body)!==sha256)throw new Error('Pinned campaign alignment plan required');
 const data=which=>({campaign_quizzes:plan.pages.map(p=>p[which]),...Object.fromEntries(Object.entries(plan.tables).map(([t,v])=>[t,v[which]])),campaign_quiz_routes:[],campaign_quiz_revisions:which==='before'?Array.from({length:plan.stagingRevisionCount},()=>({})):[]});
 const rebuilt=buildCampaignAlignmentPlan(data('before'),data('after'),plan);
 if(rebuilt.sha256!==sha256)throw new Error('Campaign scope or protected fields differ from the reviewed plan');
 return plan;
}
async function snapshot(tx){
 const out={};for(const table of ['campaign_quizzes',...Object.keys(RELATIONS)])out[table]=sorted(table,(await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t`)).map(r=>r.row));return out;
}
function matchesPlan(value,plan,which){
 return same(value.campaign_quizzes.map(editorial),plan.pages.map(p=>p[which]))
  &&Object.keys(RELATIONS).every(t=>same(relations(t,value[t]),plan.tables[t][which]));
}
async function questionDependencies(tx,ids,{published}){
 if(!ids.length)return;const unique=[...new Set(ids)];
 const rows=await tx`SELECT q.id,q.status,q.visibility,q.ranked_eligible,p.id AS payload_id FROM questions q LEFT JOIN question_payloads p ON p.question_id=q.id WHERE q.id=ANY(${tx.array(unique)}::uuid[])`;
 if(rows.length!==unique.length||rows.some(q=>q.ranked_eligible!==false||!q.payload_id||(published&&(q.status!=='published'||q.visibility!=='public'))))throw new Error('Campaign question dependencies are missing, unreserved or not published/public');
}
async function replaceRelations(tx,table,rows){
 // The full relation graph is already in the private batch row in this same
 // atomic transaction. No question, payload, rating or revision is deleted.
 await tx.unsafe(`DELETE FROM public.${table}`);
 for(const withTimestamp of [false,true]){
  const group=rows.filter(r=>Object.hasOwn(r,'created_at')===withTimestamp);if(!group.length)continue;
  const fields=[...RELATIONS[table],...(withTimestamp?['created_at']:[])];const columns=fields.map(k=>'"'+k+'"').join(',');
  await tx.unsafe(`INSERT INTO public.${table} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${table},$1::jsonb)`,[group]);
 }
}
async function updatePages(tx,rows){
 const fields=Object.keys(rows[0]).filter(k=>k!=='slug'&&!LOCAL_FIELDS.has(k));
 if(fields.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('Invalid campaign column');
 const result=await tx.unsafe(`UPDATE public.campaign_quizzes q SET ${fields.map(k=>'"'+k+'"=s."'+k+'"').join(',')}
  FROM jsonb_populate_recordset(NULL::public.campaign_quizzes,$1::jsonb) s WHERE q.slug=s.slug RETURNING q.slug`,[rows]);
 if(result.length!==rows.length)throw new Error('Campaign page count changed');
}
/** Staging-only atomic curation alignment. Run after question state parity and
 * before asset bindings. Whole-batch undo refuses subsequent editorial edits.
 */
export async function runCampaignAlignment({databaseUrl,plan:input,expectedSha256,action='dry-run',rehearsal=false,evidence={}}){
 const plan=validateCampaignAlignmentPlan(input,expectedSha256),url=new URL(databaseUrl);
 if(!['dry-run','apply','undo','undo-dry-run'].includes(action))throw new Error('Unknown campaign alignment action');
 if(rehearsal&&(url.hostname!=='127.0.0.1'||url.port!=='55519'||!/^\/rehearsal_[a-z0-9_]+$/.test(url.pathname)))throw new Error('Isolated rehearsal connection required');
 checkQuestionImportTarget(databaseUrl,STAGING,{allowLocal:rehearsal});
 if(!rehearsal&&!['require','verify-full','verify-ca'].includes(url.searchParams.get('sslmode')))throw new Error('Encrypted staging connection required');
 const dryRun=action.endsWith('dry-run'),undo=action.startsWith('undo');
 if(!dryRun&&!rehearsal&&(!evidence.fullStagingRestoreVerified||!evidence.runtimeDrained||!['backupSha256','reservationSha256','rehearsalSha256'].every(k=>digest(evidence[k]))))throw new Error('Verified staging recovery, reservation and rehearsal required');
 const sql=postgres(databaseUrl,{max:1,prepare:false,onnotice:()=>{}});
 try{return await sql.begin(dryRun?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
  await tx`SET LOCAL timezone='UTC'`;await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
  if(!dryRun){await tx`SELECT pg_advisory_xact_lock(20260919,33342)`;await tx`LOCK TABLE campaign_quizzes,campaign_quiz_questions,campaign_quiz_manual_questions,campaign_quiz_related_pages,campaign_quiz_routes,campaign_quiz_revisions,questions,question_payloads IN SHARE ROW EXCLUSIVE MODE`;}
  const current=await snapshot(tx),[batch]=await tx`SELECT * FROM campaign_alignment_batches WHERE id=${plan.sha256}`;
  const report={planSha256:plan.sha256,action,dryRun,changed:false,resumed:false,needsReview:false,questionsDeleted:0};
  if(batch&&(batch.source_project!==PROD||batch.target_project!==STAGING||batch.plan_sha256!==plan.sha256||!batch.after_data))throw new Error('Campaign journal is incomplete or differs');
  if(undo){if(!batch)throw new Error('No campaign alignment to undo');if(batch.undone_at){report.resumed=true;return report;}if(!same(current,batch.after_data)){report.needsReview=true;return report;}}
  else if(batch){if(batch.undone_at)throw new Error('Undone campaign alignment cannot be reapplied');if(!same(current,batch.after_data))throw new Error('Campaign content changed after alignment');report.resumed=true;return report;}
  else{
   if(!matchesPlan(current,plan,'before'))throw new Error('Campaign content changed since review');
   const [routes]=await tx`SELECT count(*)::int n FROM campaign_quiz_routes`;
   const [revisions]=await tx`SELECT count(*)::int n FROM campaign_quiz_revisions`;
   if(routes.n||revisions.n!==plan.stagingRevisionCount)throw new Error('Campaign route or revision history changed since review');
   const [state]=await tx`SELECT preservation_map FROM question_release_batches WHERE id=${plan.questionStatePlanSha256}`;
   const [stateUndo]=await tx`SELECT count(*)::int n FROM question_release_rows WHERE batch_id=${plan.questionStatePlanSha256} AND phase='undo'`;
   if(state?.preservation_map?.operation!=='staging-question-state-parity'||stateUndo.n)throw new Error('Complete canonical question-state alignment required');
  }
  const desired=undo?batch.before_data:{campaign_quizzes:plan.pages.map(p=>p.after),...Object.fromEntries(Object.entries(plan.tables).map(([table,values])=>{
   const existing=new Map(current[table].map(r=>[identity(table,r),r]));
   return [table,values.after.map(r=>({...r,...(existing.has(identity(table,r))?{created_at:existing.get(identity(table,r)).created_at}:{})}))];
  }))};
  await questionDependencies(tx,desired.campaign_quiz_questions.map(r=>r.question_id),{published:!undo});
  // Ownership also includes archived manual questions; retaining those markers
  // must not publish the question or expose its private content.
  await questionDependencies(tx,desired.campaign_quiz_manual_questions.map(r=>r.question_id),{published:false});
  // The trigger must be a no-op for both graph versions, including on undo.
  await questionDependencies(tx,current.campaign_quiz_questions.map(r=>r.question_id),{published:false});
  if(dryRun)return {...report,plannedPages:plan.pages.length};
  const allQuestionIds=[...new Set([...current.campaign_quiz_questions,...desired.campaign_quiz_questions].map(r=>r.question_id))];
  const questionsBefore=await tx`SELECT to_jsonb(q) AS row FROM questions q WHERE id=ANY(${tx.array(allQuestionIds)}::uuid[]) ORDER BY id`;
  if(!undo)await tx`INSERT INTO campaign_alignment_batches(id,source_project,target_project,plan_sha256,before_data,verification)
   VALUES(${plan.sha256},${PROD},${STAGING},${plan.sha256},${tx.json(current)},${tx.json({evidence,rehearsal,questionStatePlanSha256:plan.questionStatePlanSha256})})`;
  await tx`SELECT set_config('quizball.campaign_quiz_write','on',true)`;
  // Replace ownership and assignments atomically. Both original graphs and
  // the full pages are retained in the private journal.
  for(const table of ['campaign_quiz_manual_questions','campaign_quiz_questions','campaign_quiz_related_pages'])if(!same(relations(table,current[table]),relations(table,desired[table])))await replaceRelations(tx,table,desired[table]);
  await updatePages(tx,desired.campaign_quizzes);
  const after=await snapshot(tx);
  const expected={campaign_quizzes:desired.campaign_quizzes.map(editorial),...Object.fromEntries(Object.keys(RELATIONS).map(t=>[t,relations(t,desired[t])]))};
  const actual={campaign_quizzes:after.campaign_quizzes.map(editorial),...Object.fromEntries(Object.keys(RELATIONS).map(t=>[t,relations(t,after[t])]))};
  if(!same(actual,expected))throw new Error('Campaign final graph differs from the plan');
  if(!same(await tx`SELECT to_jsonb(q) AS row FROM questions q WHERE id=ANY(${tx.array(allQuestionIds)}::uuid[]) ORDER BY id`,questionsBefore))throw new Error('Campaign assignment changed preserved question data');
  const local=rows=>rows.map(r=>Object.fromEntries(['slug',...LOCAL_FIELDS].filter(k=>k!=='updated_at').map(k=>[k,r[k]??null])));
  if(!same(local(current.campaign_quizzes),local(after.campaign_quizzes)))throw new Error('Campaign alignment changed local authors or preview secrets');
  if(undo)await tx`UPDATE campaign_alignment_batches SET undo_data=${tx.json(after)},undone_at=now() WHERE id=${plan.sha256}`;
  else await tx`UPDATE campaign_alignment_batches SET after_data=${tx.json(after)} WHERE id=${plan.sha256}`;
  report.changed=true;return report;
 });}finally{await sql.end({timeout:5});}
}
