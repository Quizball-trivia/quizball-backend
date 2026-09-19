import {contentHash} from './question-manifest.mjs';
import {validateReleaseMediaPlan} from './release-media.mjs';
const TABLE_COLUMNS={question_payloads:'payload',football_players:'image_url',fifa_cards:'image_url',squad_spin_players:'image_url',goal_choreographies:'mirrored_url'};
const PROD='lfbwhxvwubzeqkztghok',STAGE='nsdfiprfmhdqhbfxfwpv';
const isHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);

/** Bind only assets with complete, matching source-plan and destination receipts. */
export function verifiedMediaUrlMap(plans,receipts){
 if(!Array.isArray(plans)||!plans.length)throw new Error('Verified source media plans are required');
 const saved=new Map();
 for(const receipt of receipts){
  const previous=saved.get(receipt.publicUrl);
  if(previous&&(previous.sha256!==receipt.sha256||previous.bytes!==receipt.bytes||previous.contentType!==receipt.contentType))throw new Error('Conflicting destination receipts');
  saved.set(receipt.publicUrl,receipt);
 }
 const mapping={},evidence=[];
 for(const plan of plans){
  validateReleaseMediaPlan(plan,plan.sha256);
  for(const row of plan.objects){
   const receipt=saved.get(row.publicUrl);
   if(!receipt||receipt.sha256!==row.sha256||receipt.bytes!==row.bytes||receipt.contentType!==row.contentType||receipt.bucket!==row.bucket||receipt.key!==row.key||!Number.isFinite(Date.parse(receipt.verifiedAt)))throw new Error('Production media verification is incomplete');
   for(const source of row.sourceUrls){
    if(mapping[source]&&mapping[source]!==row.publicUrl)throw new Error('Source URI has different released bytes');
    mapping[source]=row.publicUrl;
   }
   evidence.push({url:row.publicUrl,sha256:row.sha256,bytes:row.bytes});
  }
 }
 return {mapping,verificationSha256:contentHash({plans:plans.map(p=>p.sha256).sort(),destinations:evidence.sort((a,b)=>a.url.localeCompare(b.url))})};
}

export function bindRuntimeMedia(table,row,mapping){
 if(!Object.hasOwn(TABLE_COLUMNS,table))throw new Error('Unsupported media table');
 const result=structuredClone(row);
 function bind(value){
  if(value===null||value===undefined||value==='')return value;
  if(typeof value!=='string')throw new Error('Invalid runtime media URL');
  const target=mapping[value];
  if(!target)throw new Error('Runtime asset has no verified production destination');
  return target;
 }
 if(table==='question_payloads'){
  if(!result.payload||typeof result.payload!=='object'||Array.isArray(result.payload))throw new Error('Expected structured question payload');
  for(const key of ['image_a_url','image_b_url'])if(result.payload[key])result.payload[key]=bind(result.payload[key]);
  if(result.payload.image?.url)result.payload.image.url=bind(result.payload.image.url);
 }else if(result[TABLE_COLUMNS[table]])result[TABLE_COLUMNS[table]]=bind(result[TABLE_COLUMNS[table]]);
 return result;
}
export function buildMediaBindingPlan(rows,{targetProject,mapping,verificationSha256}){
 if(![PROD,STAGE].includes(targetProject)||!isHash(verificationSha256)||!mapping||typeof mapping!=='object')throw new Error('Pinned target and asset verification required');
 for(const [source,target] of Object.entries(mapping)){
  const from=new URL(source),to=new URL(target);
  if(from.protocol!=='https:'||from.username||from.password||to.origin!==`https://${PROD}.supabase.co`||!/^\/storage\/v1\/object\/public\/(imgs|goal-clips)\/releases\/[a-f0-9]{64}\/[a-f0-9]{64}\.(webp|png|jpg|svg|mp4)$/.test(to.pathname)||to.search||to.hash)throw new Error('Media mapping escapes its production namespace');
 }
 const ids=new Set(),changes=[];
 for(const entry of rows){
  if(!isHash(entry.contentBatchId)||!entry.before?.id)throw new Error('Content ownership and original row are required');
  const key=entry.table+':'+entry.before.id;if(ids.has(key))throw new Error('Duplicate media row');ids.add(key);
  const after=bindRuntimeMedia(entry.table,entry.before,mapping);
  if(!same(after,entry.before))changes.push({table:entry.table,id:entry.before.id,contentBatchId:entry.contentBatchId,before:entry.before,beforeHash:contentHash(entry.before),after});
 }
 changes.sort((a,b)=>(a.table+':'+a.id).localeCompare(b.table+':'+b.id));
 const body={format:1,targetProject,verificationSha256,mapping,rows:changes,policy:'runtime-URLs-only; preserve-existing-production-rows; compare-and-swap; no-delete'};
 return {...body,sha256:contentHash(body)};
}
export function validateMediaBindingPlan(plan,expectedSha256){
 const {sha256,...body}=plan;
 if(!isHash(expectedSha256)||sha256!==expectedSha256||contentHash(body)!==sha256)throw new Error('Media binding plan checksum differs');
 const rebuilt=buildMediaBindingPlan(plan.rows.map(r=>({table:r.table,contentBatchId:r.contentBatchId,before:r.before})),plan);
 if(rebuilt.sha256!==sha256)throw new Error('Media plan modifies fields outside the allowed URL binding');
 return plan;
}
// JSON receipts retain microseconds. Match the representation of the caller's
// existing row reader: postgres.js SELECT * uses Dates, to_jsonb uses strings.
function representation(proof,current){
 const result=structuredClone(proof);
 for(const [field,value] of Object.entries(current))if(value instanceof Date&&typeof result[field]==='string')result[field]=new Date(result[field]);
 return result;
}
export function originalBeforeMediaBindings(current,receipts){
 let row=current;
 const events=[];
 for(const [index,receipt] of receipts.entries()){
  const order=Number(receipt.sequence??(receipts.length-index)*2);
  events.push({order,before:receipt.before_data,after:receipt.after_data});
  if(receipt.undo_data)events.push({order:Number(receipt.undo_sequence??order+0.5),before:receipt.undo_before_data??receipt.after_data,after:receipt.undo_data});
 }
 events.sort((a,b)=>b.order-a.order);
 for(const event of events){
  const expected=representation(event.after,row);
  if(!same(row,expected))break; // A later edit must never be hidden by an old receipt.
  row=representation(event.before,row);
 }
 return row;
}
/** Normalize only an exact, journaled media transition when checking an older
 * import receipt. This never changes the database or conceals a later edit.
 */
export async function rowsBeforeMediaBindings(tx,contentBatchId,table,rows){
 if(!Object.hasOwn(TABLE_COLUMNS,table)||!rows.length)return rows;
 const receipts=await tx`SELECT row_id,sequence,before_data,after_data,undo_before_data,undo_data,undo_sequence FROM content_media_binding_rows
   WHERE content_batch_id=${contentBatchId} AND table_name=${table} AND row_id=ANY(${tx.array(rows.map(r=>r.id))}::uuid[]) ORDER BY sequence DESC`;
 const groups=new Map();for(const receipt of receipts){if(!groups.has(receipt.row_id))groups.set(receipt.row_id,[]);groups.get(receipt.row_id).push(receipt);}
 return rows.map(row=>originalBeforeMediaBindings(row,groups.get(row.id)??[]));
}
async function transaction(sql,fn,dryRun){return sql.begin(dryRun?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
 await tx`SET LOCAL timezone='UTC'`;await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
 if(!dryRun)await tx`SELECT pg_advisory_xact_lock(20260919,232522)`;
 return fn(tx);
});}
async function read(tx,table,ids,lock=false){
 if(!Object.hasOwn(TABLE_COLUMNS,table))throw new Error('Unsupported table');
 return (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE id=ANY($1::uuid[])${lock?' FOR UPDATE':''}`,[ids])).map(r=>r.row);
}
async function assertOwned(tx,rows,targetProject,allowStagingOriginals){
 if(!rows.length||(targetProject===STAGE&&allowStagingOriginals))return;
 const table=rows[0].table,ids=rows.map(r=>r.id),batches=[...new Set(rows.map(r=>r.contentBatchId))];
 let owned;
 if(table==='question_payloads')owned=await tx`SELECT batch_id,row_id FROM question_release_rows WHERE batch_id=ANY(${tx.array(batches)}::text[]) AND table_name='question_payloads' AND row_id=ANY(${tx.array(ids)}::uuid[]) AND phase='import' AND before_data IS NULL`;
 else if(table==='squad_spin_players')owned=await tx`SELECT b.id AS batch_id,ids.row_id FROM feature_content_release_batches b JOIN feature_content_release_chunks c ON c.batch_id=b.id
   CROSS JOIN LATERAL unnest(c.source_row_ids) AS ids(row_id)
   WHERE b.id=ANY(${tx.array(batches)}::text[]) AND b.feature_group='squad' AND b.state='imported' AND c.table_name='squad_spin_players' AND c.source_row_ids && ${tx.array(ids)}::uuid[] AND ids.row_id=ANY(${tx.array(ids)}::uuid[])`;
 else owned=await tx`SELECT batch_id,row_id FROM reference_release_rows WHERE batch_id=ANY(${tx.array(batches)}::text[]) AND table_name=${table} AND row_id=ANY(${tx.array(ids)}::uuid[]) AND operation='insert' AND undone_at IS NULL`;
 const keys=new Set(owned.map(r=>r.batch_id+':'+r.row_id));
 if(rows.some(r=>!keys.has(r.contentBatchId+':'+r.id)))throw new Error('Only release-owned additions may receive production media bindings');
}
function batchManifest(plan){
 return {format:plan.format,planSha256:plan.sha256,targetProject:plan.targetProject,verificationSha256:plan.verificationSha256,
   mappingSha256:contentHash(plan.mapping),rowCount:plan.rows.length,policy:plan.policy};
}

/** Operator primitive: the caller must pin the actual database connection to
 * plan.targetProject. Staging-original bindings require its restored backup and
 * editorial reservation. No cloud CLI or automatic publication is provided.
 */
export async function applyMediaBindings(sql,input,{expectedSha256,dryRun=true,undo=false,allowStagingOriginals=false}={}){
 const plan=validateMediaBindingPlan(input,expectedSha256);
 if(allowStagingOriginals&&plan.targetProject!==STAGE)throw new Error('Existing production content cannot be rebound');
 const manifest=batchManifest(plan);
 const report={batchId:plan.sha256,dryRun,undo,changed:0,resumed:0,needsReview:[],deleted:0};
 const inspect=async(tx,chunk,locked)=>{
  const table=chunk[0].table,ids=chunk.map(r=>r.id),current=new Map((await read(tx,table,ids,locked)).map(r=>[r.id,r]));
  const saved=new Map((await tx`SELECT * FROM content_media_binding_rows WHERE batch_id=${plan.sha256} AND table_name=${table} AND row_id=ANY(${tx.array(ids)}::uuid[])`).map(r=>[r.row_id,r]));
  const changes=[];
  if(!undo)await assertOwned(tx,chunk.filter(row=>!saved.has(row.id)),plan.targetProject,allowStagingOriginals);
  for(const row of chunk){
   const value=current.get(row.id),prior=saved.get(row.id);
   if(prior&&(prior.content_batch_id!==row.contentBatchId||!same(prior.before_data,row.before)))throw new Error('Media row receipt differs from the pinned plan');
   if(undo){
    if(!prior)throw new Error('No media binding to undo');
    if(prior.undo_data){report.resumed++;continue;}
    if(!same(value,prior.after_data)){report.needsReview.push(row.id);continue;}
    changes.push({row,current:value,to:prior.before_data});
   }else{
    if(prior?.undo_data)throw new Error('Undone media binding cannot be automatically reapplied');
    if(prior){if(!same(value,prior.after_data))throw new Error('Bound content was edited');report.resumed++;continue;}
    if(!same(value,row.before))throw new Error('Content changed since the media snapshot');
    changes.push({row,current:value,to:row.after});
   }
  }
  return changes;
 };
 const groups=Object.keys(TABLE_COLUMNS).map(table=>plan.rows.filter(r=>r.table===table)).filter(rows=>rows.length);
 // Full preflight before any chunk writes; locked comparisons repeat below.
 await transaction(sql,async tx=>{
  const [batch]=await tx`SELECT * FROM content_media_binding_batches WHERE id=${plan.sha256}`;
  if(batch&&(batch.target_project!==plan.targetProject||!same(batch.manifest,manifest)))throw new Error('Binding batch differs');
  if(undo&&!batch)throw new Error('No media binding to undo');
  for(const rows of groups)for(let i=0;i<rows.length;i+=100)await inspect(tx,rows.slice(i,i+100),false);
 },true);
 report.resumed=0;report.needsReview=[];
 if(!dryRun&&!undo)await transaction(sql,async tx=>{
  await tx`INSERT INTO content_media_binding_batches(id,target_project,manifest) VALUES(${plan.sha256},${plan.targetProject},${tx.json(manifest)}) ON CONFLICT(id) DO NOTHING`;
  const [batch]=await tx`SELECT * FROM content_media_binding_batches WHERE id=${plan.sha256}`;
  if(batch.target_project!==plan.targetProject||!same(batch.manifest,manifest))throw new Error('Binding batch differs');
 },false);
 for(const rows of groups)for(let i=0;i<rows.length;i+=100)await transaction(sql,async tx=>{
  for(const change of await inspect(tx,rows.slice(i,i+100),!dryRun)){
   if(dryRun){report.changed++;continue;}
   const {row,current,to}=change,table=row.table,column=TABLE_COLUMNS[table];
   const [result]=await tx.unsafe(`UPDATE public.${table} t SET ${column}=s.${column} FROM jsonb_populate_record(NULL::public.${table},$1::jsonb) s WHERE t.id=$2::uuid RETURNING to_jsonb(t) AS row`,[to,row.id]);
   if(!result)throw new Error('Binding row disappeared');
   const expected=structuredClone(to),actual=structuredClone(result.row);delete expected.updated_at;delete actual.updated_at;
   if(!same(expected,actual))throw new Error('Binding changed fields outside the asset URL and update timestamp');
   if(undo)await tx`UPDATE content_media_binding_rows SET undo_before_data=${tx.json(current)},undo_data=${tx.json(result.row)},undo_sequence=nextval('public.content_media_binding_rows_sequence_seq'),undone_at=now() WHERE batch_id=${plan.sha256} AND table_name=${table} AND row_id=${row.id}`;
   else await tx`INSERT INTO content_media_binding_rows(batch_id,content_batch_id,table_name,row_id,before_data,after_data) VALUES(${plan.sha256},${row.contentBatchId},${table},${row.id},${tx.json(current)},${tx.json(result.row)})`;
   report.changed++;
  }
 },dryRun);
 return report;
}
