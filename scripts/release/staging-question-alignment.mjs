import postgres from 'postgres';
import {contentHash} from './question-manifest.mjs';
import {validateQuestionPackage} from './question-package.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
import {rowsBeforeMediaBindings} from './content-media-bindings.mjs';

const STAGING='nsdfiprfmhdqhbfxfwpv',PRODUCTION='lfbwhxvwubzeqkztghok';
const FIELDS=['category_id','type','difficulty','status','prompt','explanation','ranked_eligible','visibility'];
const ROOTS=['matches','free_kicks_rounds','trivia_mines_rounds','road_to_goal_rounds','squad_spin_rounds','guess_the_goal_sessions'];
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);
const pick=row=>Object.fromEntries(FIELDS.map(k=>[k,row[k]??null]));
const key=(table,id)=>table+':'+id;
// The existing import journal serializes driver Dates at millisecond precision.
// Alignment's own receipts keep PostgreSQL's full-precision JSON representation.
const importReceiptShape=row=>Object.fromEntries(Object.entries(row).map(([field,value])=>
  [field,['created_at','updated_at'].includes(field)&&value!==null?new Date(value).toISOString():value]));

export function validateAlignmentInput(plan,expectedSha256){
  const {sha256,...body}=plan;
  if(!/^[a-f0-9]{64}$/.test(expectedSha256??'')||sha256!==expectedSha256||contentHash(body)!==sha256
    ||plan.format!==1||plan.targetProject!==STAGING||plan.sourceProject!==PRODUCTION)throw new Error('Expected the pinned production-to-staging alignment plan');
  validateQuestionPackage(plan.preservation);
  const drafts=new Map(plan.preservation.additions.filter(r=>r.kind==='conflict-draft').map(r=>[r.question.id,r]));
  const ids=new Set(),payloads=new Set();
  for(const row of plan.updates){
    if(ids.has(row.id)||payloads.has(row.baseline.payloadId)||!drafts.has(row.draftId)
      ||contentHash(row.baseline)!==row.beforeHash||row.after.payloadId!==row.baseline.payloadId
      ||Object.keys(row.after.question).sort().join(',')!==[...FIELDS].sort().join(','))throw new Error('Invalid alignment identity or baseline');
    ids.add(row.id);payloads.add(row.baseline.payloadId);
    const draft=drafts.get(row.draftId);
    if(draft.provenance.sourceQuestionId!==row.id||!same(draft.payload.payload,row.baseline.payload)
      ||!same({...pick(draft.question),status:row.baseline.question.status,ranked_eligible:row.baseline.question.ranked_eligible},row.baseline.question))throw new Error('Draft does not preserve the original question');
  }
  if(ids.size!==drafts.size)throw new Error('Incomplete conflict preservation map');
  return plan;
}

async function activity(tx){
  const counts={};
  for(const table of ROOTS){
    const condition=table==='guess_the_goal_sessions'?"state IN ('active','guessed')":"status='active'";
    counts[table]=Number((await tx.unsafe(`SELECT count(*)::text n FROM public.${table} WHERE ${condition}`))[0].n);
  }
  return counts;
}
async function currentRows(tx,ids,lock){
  const rows=await tx.unsafe(`SELECT to_jsonb(q) AS question,to_jsonb(p) AS payload FROM public.questions q JOIN public.question_payloads p ON p.question_id=q.id WHERE q.id=ANY($1::uuid[])${lock?' FOR UPDATE OF q,p':''}`,[ids]);
  return new Map(rows.map(r=>[r.question.id,r]));
}
async function assertDrafts(tx,plan,lock){
  const drafts=plan.preservation.additions.filter(r=>r.kind==='conflict-draft');
  const current=await currentRows(tx,drafts.map(r=>r.question.id),lock);
  const payloads=await rowsBeforeMediaBindings(tx,plan.preservation.sha256,'question_payloads',[...current.values()].map(r=>r.payload));
  for(const payload of payloads)current.get(payload.question_id).payload=payload;
  const receipts=await tx`SELECT * FROM question_release_rows WHERE batch_id=${plan.preservation.sha256} AND phase='import'`;
  const prior=new Map(receipts.map(r=>[key(r.table_name,r.row_id),r.after_data]));
  for(const draft of drafts){
    const row=current.get(draft.question.id);
    if(!row||row.question.status!=='draft'||!prior.has(key('questions',row.question.id))||!prior.has(key('question_payloads',row.payload.id))
      ||!same(importReceiptShape(row.question),prior.get(key('questions',row.question.id)))||!same(importReceiptShape(row.payload),prior.get(key('question_payloads',row.payload.id)))
      ||!same(pick(row.question),pick(draft.question))||!same(row.payload.payload,draft.payload.payload))throw new Error('Preserved draft is missing or was edited');
  }
}
async function freezeHistory(tx,ids){
  // Append a historical version; never repoint or remove a gameplay record.
  const [result]=await tx`WITH frozen AS (UPDATE public.match_questions mq SET content_snapshot=jsonb_build_object(
      'prompt',q.prompt,'difficulty',q.difficulty,'payload',p.payload,'category_name',c.name,'category_icon',c.icon)
    FROM public.questions q JOIN public.question_payloads p ON p.question_id=q.id, public.categories c
    WHERE mq.question_id=q.id AND c.id=mq.category_id AND q.id=ANY(${tx.array(ids)}::uuid[]) AND mq.content_snapshot IS NULL
    RETURNING 1) SELECT count(*)::int AS n FROM frozen`;
  return result.n;
}
async function updateAndJournal(tx,plan,changes,phase){
  let changed=0;
  for(let i=0;i<changes.length;i+=100){
    const chunk=changes.slice(i,i+100);
    const questions=chunk.map(r=>({id:r.id,...r.to.question}));
    const payloads=chunk.map(r=>({id:r.to.payloadId,payload:r.to.payload}));
    const afterQuestions=(await tx`UPDATE public.questions q SET ${tx.unsafe(FIELDS.map(f=>f+'=s.'+f).join(','))}
      FROM jsonb_populate_recordset(NULL::public.questions,${tx.json(questions)}) s WHERE q.id=s.id RETURNING to_jsonb(q) AS row`).map(r=>r.row);
    const afterPayloads=(await tx`UPDATE public.question_payloads p SET payload=s.payload
      FROM jsonb_populate_recordset(NULL::public.question_payloads,${tx.json(payloads)}) s WHERE p.id=s.id RETURNING to_jsonb(p) AS row`).map(r=>r.row);
    if(afterQuestions.length!==chunk.length||afterPayloads.length!==chunk.length)throw new Error('Alignment update count mismatch');
    const byQuestion=new Map(chunk.map(r=>[r.id,r])),byPayload=new Map(chunk.map(r=>[r.to.payloadId,r]));
    const entries=[...afterQuestions.map(row=>({batch_id:plan.sha256,table_name:'questions',row_id:row.id,phase,before_data:tx.json(byQuestion.get(row.id).from.question),after_data:tx.json(row)})),
      ...afterPayloads.map(row=>({batch_id:plan.sha256,table_name:'question_payloads',row_id:row.id,phase,before_data:tx.json(byPayload.get(row.id).from.payload),after_data:tx.json(row)}))];
    await tx`INSERT INTO question_release_rows ${tx(entries)}`;changed+=chunk.length;
  }
  return changed;
}

/** Staging only. Cloud apply/undo additionally requires the completed recovery,
 * history and replica-drain evidence from the operator packet. The database
 * transaction also blocks new game writes and refuses any active game.
 */
export async function runStagingQuestionAlignment({databaseUrl,plan:input,expectedPlanSha256,action='dry-run',rehearsal=false,evidence={}}){
  if(!['dry-run','apply','undo','undo-dry-run'].includes(action))throw new Error('Unknown alignment action');
  const plan=validateAlignmentInput(input,expectedPlanSha256),url=new URL(databaseUrl);
  if(rehearsal&&(url.hostname!=='127.0.0.1'||url.port!=='55519'||!/^\/rehearsal_[a-z0-9_]+$/.test(url.pathname)))throw new Error('Isolated rehearsal connection required');
  checkQuestionImportTarget(databaseUrl,STAGING,{allowLocal:rehearsal});
  const dryRun=action.endsWith('dry-run'),undo=action.startsWith('undo');
  if(!dryRun&&!rehearsal&&(!evidence.fullStagingRestoreVerified||!evidence.historyAuditComplete||!evidence.runtimeDrained||!evidence.oldReplicasStopped
    ||!['backupSha256','historyAuditSha256','mediaVerificationSha256','reservationSha256'].every(k=>/^[a-f0-9]{64}$/.test(evidence[k]??''))))throw new Error('Complete staging preservation and runtime reservation evidence is required');
  const sql=postgres(databaseUrl,{max:1,prepare:false,onnotice:()=>{}});
  try{return await sql.begin(dryRun?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
    await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;await tx`SET LOCAL timezone='UTC'`;
    if(!dryRun){
      await tx`SELECT pg_advisory_xact_lock(20260919,33342)`;
      await tx.unsafe(`LOCK TABLE ${ROOTS.map(t=>'public.'+t).join(',')},public.match_questions,public.questions,public.question_payloads,public.categories IN SHARE ROW EXCLUSIVE MODE`);
    }
    const active=await activity(tx);
    if(!dryRun&&Object.values(active).some(n=>n))throw new Error('Staging still has active gameplay; alignment refused');
    const ids=plan.updates.map(r=>r.id),current=await currentRows(tx,ids,!dryRun);
    if(current.size!==ids.length)throw new Error('An original staging question or payload is missing');
    const receipts=await tx`SELECT * FROM question_release_rows WHERE batch_id=${plan.sha256}`;
    const [existingBatch]=await tx`SELECT * FROM question_release_batches WHERE id=${plan.sha256}`;
    const applied=new Map(receipts.filter(r=>r.phase==='align').map(r=>[key(r.table_name,r.row_id),r]));
    const undone=new Map(receipts.filter(r=>r.phase==='undo').map(r=>[key(r.table_name,r.row_id),r]));
    const report={batchId:plan.sha256,dryRun,action,activeGames:active,changed:0,alreadyApplied:0,alreadyUndone:0,needsReview:[],historySnapshotsAdded:0,deletedRows:0};
    if(applied.size&&applied.size!==ids.length*2)throw new Error('Partial alignment receipts require review');
    if(existingBatch&&(existingBatch.source_project!==PRODUCTION||existingBatch.target_project!==STAGING
      ||existingBatch.manifest_sha256!==plan.sha256
      ||existingBatch.preservation_map?.operation!=='production-canonical-staging-alignment'
      ||existingBatch.preservation_map?.planSha256!==plan.sha256
      ||existingBatch.preservation_map?.preservationPackageSha256!==plan.preservation.sha256))throw new Error('Alignment batch metadata differs');
    if(applied.size&&!existingBatch)throw new Error('Alignment batch metadata is missing');
    if(undo&&!applied.size)throw new Error('No completed alignment to undo');
    if(!undo){
      if(undone.size)throw new Error('An undone alignment cannot be automatically reapplied');
      await assertDrafts(tx,plan,!dryRun);
    }
    const changes=[];
    for(const row of plan.updates){
      const from=current.get(row.id),qKey=key('questions',row.id),pKey=key('question_payloads',row.baseline.payloadId);
      if(undo){
        if(undone.has(qKey)&&undone.has(pKey)){report.alreadyUndone++;continue;}
        if(undone.has(qKey)||undone.has(pKey))throw new Error('Partial undo receipt');
        const q=applied.get(qKey),p=applied.get(pKey);
        if(!q||!p||!same(from.question,q.after_data)||!same(from.payload,p.after_data)){report.needsReview.push(row.id);continue;}
        changes.push({id:row.id,from,to:{question:pick(q.before_data),payloadId:p.before_data.id,payload:p.before_data.payload}});
      }else if(applied.size){
        if(!same(from.question,applied.get(qKey)?.after_data)||!same(from.payload,applied.get(pKey)?.after_data))throw new Error('Aligned content was edited; retry refused');
        report.alreadyApplied++;
      }else{
        const baseline={question:pick(from.question),payloadId:from.payload.id,payload:from.payload.payload};
        if(!same(baseline,row.baseline))throw new Error('Staging question changed since the pinned snapshot');
        changes.push({id:row.id,from,to:row.after});
      }
    }
    report.planned=changes.length;
    if(dryRun||!changes.length)return report;
    const preservation={operation:'production-canonical-staging-alignment',planSha256:plan.sha256,preservationPackageSha256:plan.preservation.sha256,
      productionSnapshotHash:plan.productionSnapshotHash,stagingSnapshotHash:plan.stagingSnapshotHash,evidence,rehearsal};
    if(!undo){
      await tx`INSERT INTO question_release_batches(id,source_project,target_project,manifest_sha256,preservation_map)
        VALUES(${plan.sha256},${PRODUCTION},${STAGING},${plan.sha256},${tx.json(preservation)}) ON CONFLICT(id) DO NOTHING`;
      const [batch]=await tx`SELECT * FROM question_release_batches WHERE id=${plan.sha256}`;
      if(batch.source_project!==PRODUCTION||batch.target_project!==STAGING||batch.manifest_sha256!==plan.sha256||!same(batch.preservation_map,preservation))throw new Error('Alignment batch metadata differs');
    }
    report.historySnapshotsAdded=await freezeHistory(tx,changes.map(r=>r.id));
    report.changed=await updateAndJournal(tx,plan,changes,undo?'undo':'align');
    return report;
  });}finally{await sql.end({timeout:5});}
}
