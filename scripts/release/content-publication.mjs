import {contentHash} from './question-manifest.mjs';
const PROD='lfbwhxvwubzeqkztghok';
const FIELDS={fifa_cards:['is_active'],goal_choreographies:['status','featured_rank'],player_clue_cards:['status'],squad_spin_combos:['active'],football_grid_content_releases:['status','approved_by','approved_at','published_at']};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);
const fieldValues=(table,row)=>Object.fromEntries(FIELDS[table].map(k=>[k,row[k]??null]));
export function buildContentPublicationPlan(entries,{verificationSha256}){
 if(!hash(verificationSha256)||!Array.isArray(entries)||!entries.length)throw new Error('Reviewed publication selections and verification are required');
 const seen=new Set(),rows=[];
 for(const entry of entries){
  const {table,before,publication,contentBatchId}=entry;
  if(!Object.hasOwn(FIELDS,table)||!before?.id||!hash(contentBatchId)||!publication||Object.keys(publication).sort().join(',')!==[...FIELDS[table]].sort().join(','))throw new Error('Invalid content publication scope');
  const id=table+':'+before.id;if(seen.has(id))throw new Error('Duplicate publication identity');seen.add(id);
  if(table==='fifa_cards'&&(before.is_active!==false||publication.is_active!==true))throw new Error('Only inactive additions can be activated');
  if(table==='squad_spin_combos'&&(before.active!==false||publication.active!==true))throw new Error('Only inactive combinations can be activated');
  if(table==='goal_choreographies'&&(before.status!=='draft'||publication.status!=='published'))throw new Error('Only draft goals can be published');
  if(table==='player_clue_cards'&&(before.status!=='needs_review'||publication.status!=='published'))throw new Error('Only reviewed clue additions can be published');
  if(table==='football_grid_content_releases'&&(before.status!=='draft'||publication.status!=='published'||!publication.approved_by||!Number.isFinite(Date.parse(publication.approved_at))||!Number.isFinite(Date.parse(publication.published_at))))throw new Error('Original Grid approval and publication evidence are required');
  const after={...structuredClone(before),...structuredClone(publication)};
  const rollback=table==='football_grid_content_releases'?{status:'retired'}:fieldValues(table,before);
  rows.push({table,id:before.id,contentBatchId,before:structuredClone(before),after,rollback});
 }
 rows.sort((a,b)=>(a.table+':'+a.id).localeCompare(b.table+':'+b.id));
 const body={format:1,sourceProject:'nsdfiprfmhdqhbfxfwpv',targetProject:PROD,verificationSha256,policy:'reviewed-additions-only; disable-or-retire-on-undo; retain-history',rows};return {...body,sha256:contentHash(body)};
}
export function validateContentPublicationPlan(plan,expectedSha256){
 const{sha256,...body}=plan;if(!hash(expectedSha256)||sha256!==expectedSha256||contentHash(body)!==sha256)throw new Error('Publication plan checksum differs');
 const rebuilt=buildContentPublicationPlan(plan.rows.map(r=>({table:r.table,before:r.before,publication:fieldValues(r.table,r.after),contentBatchId:r.contentBatchId})),plan);
 if(rebuilt.sha256!==sha256)throw new Error('Publication changes fields outside the reviewed activation');return plan;
}
async function transaction(sql,fn,readOnly){return sql.begin(readOnly?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
 await tx`SET LOCAL timezone='UTC'`;await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
 // Match the content-import locks so publication cannot race retaining undo.
 if(!readOnly){await tx`SELECT pg_advisory_xact_lock(20260919,214519)`;await tx`SELECT pg_advisory_xact_lock(20260919,63255)`;}
 return fn(tx);
});}
async function ownership(tx,table,rows){
 if(!rows.length)return;const ids=rows.map(r=>r.id),batches=[...new Set(rows.map(r=>r.contentBatchId))];let found;
 if(table==='squad_spin_combos'||table==='football_grid_content_releases')found=await tx`SELECT b.id AS batch_id,k.row_id FROM feature_content_release_batches b JOIN feature_content_release_chunks c ON c.batch_id=b.id CROSS JOIN LATERAL unnest(c.source_row_ids) k(row_id)
  WHERE b.id=ANY(${tx.array(batches)}::text[]) AND b.state='imported' AND c.table_name=${table} AND c.source_row_ids && ${tx.array(ids)}::uuid[] AND k.row_id=ANY(${tx.array(ids)}::uuid[])`;
 else found=await tx`SELECT batch_id,row_id FROM reference_release_rows WHERE batch_id=ANY(${tx.array(batches)}::text[]) AND table_name=${table} AND row_id=ANY(${tx.array(ids)}::uuid[]) AND operation='insert' AND before_data IS NULL AND undone_at IS NULL`;
 const keys=new Set(found.map(r=>r.batch_id+':'+r.row_id));if(rows.some(r=>!keys.has(r.contentBatchId+':'+r.id)))throw new Error('Only still-owned release additions may be published');
}
/** Operator primitive. The caller pins the target and completed source/media/
 * gameplay evidence. Mode flags stay disabled until the complete plan passes.
 * Undo requires those modes disabled and retires Grid without deleting history.
 */
export async function publishReleaseContent(sql,input,{expectedSha256,dryRun=true,undo=false,modesDisabled=false}={}){
 const plan=validateContentPublicationPlan(input,expectedSha256);
 if(!dryRun&&undo&&!modesDisabled)throw new Error('Disable dependent modes before publication rollback');
 const report={batchId:plan.sha256,dryRun,undo,changed:0,resumed:0,needsReview:[],deletedRows:0};
 async function inspect(tx,table,chunk,locked){
  const ids=chunk.map(r=>r.id),current=new Map((await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE id=ANY($1::uuid[])${locked?' FOR UPDATE':''}`,[ids])).map(r=>[r.row.id,r.row]));
  const receipts=new Map((await tx`SELECT * FROM reference_release_rows WHERE batch_id=${plan.sha256} AND table_name=${table} AND row_id=ANY(${tx.array(ids)}::uuid[])`).map(r=>[r.row_id,r]));
  if(!undo)await ownership(tx,table,chunk.filter(r=>!receipts.has(r.id)));
  const changes=[];for(const row of chunk){const value=current.get(row.id),prior=receipts.get(row.id);
   if(prior&&(prior.operation!=='publish'||prior.content_batch_id!==row.contentBatchId||!same(prior.before_data,row.before)))throw new Error('Publication receipt differs from the plan');
   if(undo){if(!prior)throw new Error('No publication receipt to undo');if(prior.undone_at){report.resumed++;continue;}if(!same(value,prior.after_data)){report.needsReview.push({table,id:row.id});continue;}changes.push({row,from:value,to:{...value,...row.rollback}});}
   else{if(prior?.undone_at)throw new Error('An undone publication cannot be reapplied');if(prior){if(!same(value,prior.after_data))throw new Error('Published content was edited');report.resumed++;continue;}if(!same(value,row.before))throw new Error('Content changed since the publication review');changes.push({row,from:value,to:row.after});}
  }return changes;
 }
 const groups=Object.keys(FIELDS).map(table=>({table,rows:plan.rows.filter(r=>r.table===table)})).filter(g=>g.rows.length);
 await transaction(sql,async tx=>{
  const [batch]=await tx`SELECT * FROM reference_release_batches WHERE id=${plan.sha256}`;
  if(batch&&(batch.source_project!==plan.sourceProject||batch.target_project!==plan.targetProject||batch.policy!==plan.policy))throw new Error('Publication batch metadata differs');
  for(const group of groups)for(let i=0;i<group.rows.length;i+=100)await inspect(tx,group.table,group.rows.slice(i,i+100),false);
 },true);report.resumed=0;report.needsReview=[];
 if(!dryRun&&!undo)await transaction(sql,tx=>tx`INSERT INTO reference_release_batches(id,source_project,target_project,policy) VALUES(${plan.sha256},${plan.sourceProject},${plan.targetProject},${plan.policy}) ON CONFLICT(id) DO NOTHING`,false);
 for(const group of groups)for(let i=0;i<group.rows.length;i+=100)await transaction(sql,async tx=>{
  const changes=await inspect(tx,group.table,group.rows.slice(i,i+100),!dryRun);if(!changes.length)return;if(dryRun){report.changed+=changes.length;return;}
  const columns=undo&&group.table==='football_grid_content_releases'?['status']:FIELDS[group.table];
  const updated=await tx.unsafe(`UPDATE public.${group.table} t SET ${columns.map(k=>k+'=s.'+k).join(',')} FROM jsonb_populate_recordset(NULL::public.${group.table},$1::jsonb) s WHERE t.id=s.id RETURNING to_jsonb(t) AS row`,[changes.map(r=>r.to)]);
  if(updated.length!==changes.length)throw new Error('Publication update count differs');const byId=new Map(changes.map(r=>[r.row.id,r]));
  for(const {row} of updated){const expected={...byId.get(row.id).to},actual={...row};delete expected.updated_at;delete actual.updated_at;if(!same(expected,actual))throw new Error('Publication changed unrelated content fields');}
  if(undo)await tx`UPDATE reference_release_rows r SET undo_data=s.undo_data,undone_at=now()
    FROM jsonb_to_recordset(${tx.json(updated.map(({row})=>({row_id:row.id,undo_data:row})))}) AS s(row_id uuid,undo_data jsonb)
    WHERE r.batch_id=${plan.sha256} AND r.table_name=${group.table} AND r.row_id=s.row_id`;
  else await tx`INSERT INTO reference_release_rows ${tx(updated.map(({row})=>({batch_id:plan.sha256,table_name:group.table,row_id:row.id,operation:'publish',content_batch_id:byId.get(row.id).row.contentBatchId,before_data:tx.json(byId.get(row.id).from),after_data:tx.json(row)})))}`;
  report.changed+=updated.length;
 },dryRun);return report;
}
