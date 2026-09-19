import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { contentHash } from './question-manifest.mjs';
import { rowsBeforeMediaBindings } from './content-media-bindings.mjs';

const GROUPS = {
  squad: ['squad_spin_players','squad_spin_criteria','squad_spin_player_aliases','squad_spin_combos','squad_spin_calibrations'],
  grid: ['football_grid_content_releases','football_grid_criteria','football_grid_criterion_memberships','football_grid_data_sources','football_grid_membership_evidence','football_grid_boards','football_grid_board_answers','football_grid_player_aliases','football_grid_content_quarantines'],
};
const quote = s => '"' + s.replaceAll('"','""') + '"';
const orderedHash = rows => contentHash(rows.map(contentHash).sort());
const tablePath = (directory, table) => resolve(directory, table + '.jsonl');

/** Source archives remain byte-for-byte intact. Only publication/author fields
 * are adapted; content is imported dark. Existing target tables must be empty.
 */
export function prepareFeatureRow(table, source) {
  const row = structuredClone(source);
  if (table === 'football_grid_content_releases') {
    row.status = 'draft'; row.approved_by = null; row.approved_at = null; row.published_at = null;
  }
  if (table === 'squad_spin_combos') row.active = false;
  if (table === 'football_grid_content_quarantines') row.actor = 'release-preservation';
  return row;
}

export function featurePackage(directory, targetProject) {
  const manifest = JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
  const order = GROUPS[manifest.group];
  if (!order || !manifest.complete || manifest.snapshot?.read_only !== 'on'
      || manifest.sourceProject !== 'nsdfiprfmhdqhbfxfwpv'
      || targetProject !== 'lfbwhxvwubzeqkztghok') throw new Error('Expected complete staging source and pinned production target');
  if (manifest.tables.length !== order.length || new Set(manifest.tables.map(t=>t.table)).size !== order.length) throw new Error('Unexpected source table inventory');
  const tables = order.map(table => {
    const item = manifest.tables.find(t=>t.table===table);
    if (!item || !Number.isSafeInteger(item.rows) || item.rows<0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid source table manifest');
    return {table,rows:item.rows,sha256:item.sha256};
  });
  const body = {format:1,sourceProject:manifest.sourceProject,targetProject,group:manifest.group,
    policy:'empty-target-additive-seed; dark-publication; retain-on-undo',chunkSize:500,tables};
  return {...body,sha256:contentHash(body)};
}

async function* chunks(directory, group) {
  const path = tablePath(directory,group.table);
  if (dirname(path)!==resolve(directory)) throw new Error('Unexpected source path');
  let rows=[], index=0, count=0;
  for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})) {
    const row=JSON.parse(line);
    if(!row || Array.isArray(row) || typeof row!=='object') throw new Error('Expected source row');
    rows.push(prepareFeatureRow(group.table,row));count++;
    if(rows.length===500){yield {index:index++,rows};rows=[];}
  }
  if(rows.length)yield {index,rows};
  if(count!==group.rows)throw new Error('Source row count differs from manifest');
}

async function verifyFiles(directory,pkg) {
  for(const group of pkg.tables){
    const hash=createHash('sha256');
    for await(const block of createReadStream(tablePath(directory,group.table)))hash.update(block);
    if(hash.digest('hex')!==group.sha256)throw new Error('Source content file changed: '+group.table);
  }
}
async function transaction(sql,fn,readOnly=false){
  return sql.begin(readOnly?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
    await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
    await tx`SET LOCAL timezone='UTC'`;
    if(!readOnly)await tx`SELECT pg_advisory_xact_lock(20260919,214519)`;
    return fn(tx);
  });
}
async function tableInfo(sql,table){
  const columns=(await sql`SELECT attname FROM pg_attribute WHERE attrelid=${'public.'+table}::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`).map(r=>r.attname);
  const keys=(await sql`SELECT a.attname FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=${'public.'+table}::regclass AND c.contype='p' ORDER BY k.n`).map(r=>r.attname);
  if(!columns.length||!keys.length)throw new Error('Target table lacks columns or primary key');
  return {columns,keys};
}
async function readChunk(tx,table,info,rows,locked=false,batchId){
  const current=(await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t JOIN jsonb_populate_recordset(NULL::public.${table},$1::jsonb) s ON ${info.keys.map(k=>'t.'+quote(k)+'=s.'+quote(k)).join(' AND ')}${locked?' FOR UPDATE OF t':''}`,[rows])).map(r=>r.row);
  return table==='squad_spin_players'?rowsBeforeMediaBindings(tx,batchId,table,current):current;
}
function validateRows(info,rows){
  const keys=new Set();
  for(const row of rows){
    if(Object.keys(row).some(k=>!info.columns.includes(k))||info.keys.some(k=>row[k]==null))throw new Error('Unknown column or missing source key');
    const key=contentHash(info.keys.map(k=>row[k]));if(keys.has(key))throw new Error('Duplicate source key');keys.add(key);
  }
}

/** Target validation belongs to the operator entry point. This primitive never
 * replaces pre-existing content. An atomic chunk receipt makes retries exact;
 * imported rows edited afterward cause an explicit stop, never an overwrite.
 */
export async function importFeatureContent(sql,directory,{targetProject,dryRun=true,onProgress=()=>{}}={}){
  const pkg=featurePackage(directory,targetProject);await verifyFiles(directory,pkg);
  const infos=new Map(),report={batchId:pkg.sha256,dryRun,inserted:0,resumed:0,planned:0};
  await transaction(sql,async tx=>{
    const [batch]=await tx`SELECT * FROM feature_content_release_batches WHERE id=${pkg.sha256}`;
    if(batch&&(batch.state==='retained'||contentHash(batch.manifest)!==contentHash(pkg)))throw new Error('Batch is undone or manifest differs');
    for(const group of pkg.tables){
      const info=await tableInfo(tx,group.table);infos.set(group.table,info);
      const receipts=await tx`SELECT * FROM feature_content_release_chunks WHERE batch_id=${pkg.sha256} AND table_name=${group.table}`;
      const [total]=await tx.unsafe(`SELECT count(*)::text AS n FROM public.${group.table}`);
      if(Number(total.n)!==receipts.reduce((n,r)=>n+r.row_count,0))throw new Error('Target contains unowned or missing content: '+group.table);
      const prior=new Map(receipts.map(r=>[r.chunk_index,r]));
      for await(const chunk of chunks(directory,group)){
        validateRows(info,chunk.rows);
        const receipt=prior.get(chunk.index);
        if(receipt){
          const current=await readChunk(tx,group.table,info,chunk.rows,false,pkg.sha256);
          if(receipt.input_hash!==contentHash(chunk.rows)||receipt.row_count!==current.length||receipt.after_hash!==orderedHash(current))throw new Error('Previously imported content changed');
          prior.delete(chunk.index);
        }else report.planned+=chunk.rows.length;
      }
      if(prior.size)throw new Error('Unexpected extra receipts');
    }
  },true);
  if(dryRun)return report;
  await transaction(sql,async tx=>{
    await tx`INSERT INTO feature_content_release_batches(id,source_project,target_project,feature_group,manifest) VALUES(${pkg.sha256},${pkg.sourceProject},${pkg.targetProject},${pkg.group},${tx.json(pkg)}) ON CONFLICT(id) DO NOTHING`;
    const [batch]=await tx`SELECT * FROM feature_content_release_batches WHERE id=${pkg.sha256} FOR UPDATE`;
    if(batch.state==='retained'||contentHash(batch.manifest)!==contentHash(pkg))throw new Error('Batch changed since preflight');
  });
  for(const group of pkg.tables){
    const info=infos.get(group.table);
    for await(const chunk of chunks(directory,group))await transaction(sql,async tx=>{
      const [batch]=await tx`SELECT state FROM feature_content_release_batches WHERE id=${pkg.sha256} FOR UPDATE`;
      if(batch.state==='retained')throw new Error('Batch was undone');
      const [receipt]=await tx`SELECT * FROM feature_content_release_chunks WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND chunk_index=${chunk.index}`;
      const current=await readChunk(tx,group.table,info,chunk.rows,true,pkg.sha256);
      if(receipt){if(receipt.input_hash!==contentHash(chunk.rows)||current.length!==receipt.row_count||orderedHash(current)!==receipt.after_hash)throw new Error('Imported content changed');report.resumed+=current.length;return;}
      if(current.length)throw new Error('Content appeared after preflight; overwrite refused');
      const names=Object.keys(chunk.rows[0]).sort();
      if(chunk.rows.some(r=>Object.keys(r).sort().join(',')!==names.join(',')))throw new Error('Inconsistent source columns');
      const columns=names.map(quote).join(',');
      const inserted=(await tx.unsafe(`INSERT INTO public.${group.table} AS t (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${group.table},$1::jsonb) RETURNING to_jsonb(t) AS row`,[chunk.rows])).map(r=>r.row);
      await tx`INSERT INTO feature_content_release_chunks(batch_id,table_name,chunk_index,row_count,input_hash,after_hash,source_row_ids) VALUES(${pkg.sha256},${group.table},${chunk.index},${inserted.length},${contentHash(chunk.rows)},${orderedHash(inserted)},${group.table==='squad_spin_players'?tx.array(chunk.rows.map(r=>r.id)):null}::uuid[])`;
      report.inserted+=inserted.length;
    });
    onProgress({table:group.table,inserted:report.inserted,resumed:report.resumed});
  }
  await verifyFiles(directory,pkg);
  // Recheck every stored chunk before marking the complete package imported.
  // This also detects unrelated additions made while the long import ran.
  await importFeatureContent(sql,directory,{targetProject,dryRun:true});
  await transaction(sql,async tx=>{
    await tx`UPDATE feature_content_release_batches SET state='imported',completed_at=now() WHERE id=${pkg.sha256} AND state<>'retained'`;
  });
  return report;
}

/** Undo only a still-dark initial import. All source content and any later
 * history stay present. A published/edited root is refused for explicit review.
 */
export async function retainFeatureContentOnUndo(sql,directory,{targetProject,dryRun=true}={}){
  const pkg=featurePackage(directory,targetProject);
  const [existing]=await sql`SELECT state,manifest FROM feature_content_release_batches WHERE id=${pkg.sha256}`;
  if(existing?.state==='retained'){
    if(contentHash(existing.manifest)!==contentHash(pkg))throw new Error('Undo manifest differs');
    return {batchId:pkg.sha256,dryRun,deletedRows:0,alreadyUndone:true};
  }
  await importFeatureContent(sql,directory,{targetProject,dryRun:true});
  return transaction(sql,async tx=>{
    const [batch]=await tx`SELECT state FROM feature_content_release_batches WHERE id=${pkg.sha256}${dryRun?tx``:tx` FOR UPDATE`}`;
    if(!batch)throw new Error('No import to undo');
    const table=pkg.group==='grid'?'football_grid_content_releases':'squad_spin_combos';
    if(!dryRun)await tx.unsafe(`LOCK TABLE public.${table} IN SHARE ROW EXCLUSIVE MODE`);
    const [active]=await tx.unsafe(`SELECT count(*)::int n FROM public.${table} WHERE ${pkg.group==='grid'?"status<>'draft'":'active'}`);
    if(active.n)throw new Error('Content is no longer dark; publication rollback required');
    if(!dryRun)await tx`UPDATE feature_content_release_batches SET state='retained' WHERE id=${pkg.sha256}`;
    return {batchId:pkg.sha256,dryRun,deletedRows:0,retainedRows:pkg.tables.reduce((n,t)=>n+t.rows,0),publicationChanged:false};
  },dryRun);
}
