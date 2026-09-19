import { contentHash } from './question-manifest.mjs';
import { validateReferencePackage } from './reference-package.mjs';
import { rowsBeforeMediaBindings } from './content-media-bindings.mjs';

const TABLES = new Set(['football_players','fifa_cards','goal_choreographies','player_clue_cards']);
const same = (a,b) => contentHash(a) === contentHash(b);
const quote = value => '"' + value.replaceAll('"','""') + '"';
const baseline = (current, planned) => Object.fromEntries(planned.beforeFields.map(key => [key,current[key] ?? null]));
async function transaction(sql, fn, readOnly=false) {
  return sql.begin(readOnly ? 'ISOLATION LEVEL REPEATABLE READ READ ONLY' : '',async tx=>{
    await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='30s'`;
    await tx`SET LOCAL timezone='UTC'`;
    if(!readOnly)await tx`SELECT pg_advisory_xact_lock(20260919,63255)`;
    return fn(tx);
  });
}
async function currentRows(sql, table, ids, lock=false, batchId) {
  if(!TABLES.has(table))throw new Error('Unsupported reference table');
  if(!ids.length)return new Map();
  const rows=await sql.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE id=ANY($1::uuid[])${lock?' FOR UPDATE':''}`,[ids]);
  const values=rows.map(r=>r.row);
  return new Map((batchId?await rowsBeforeMediaBindings(sql,batchId,table,values):values).map(row=>[row.id,row]));
}
function checkRow(row,current,receipt) {
  if(receipt){
    if(receipt.undone_at)throw new Error('An undone batch cannot be automatically reapplied');
    if(!current||!same(current,receipt.after_data))throw new Error('Imported reference was edited; resume refused');
    return;
  }
  if(row.disposition==='insert') {if(current)throw new Error('Reference appeared after snapshot; no overwrite');return;}
  if(!current||contentHash(baseline(current,row))!==row.beforeHash)throw new Error('Production reference changed since snapshot');
  for(const key of Object.keys(row.fill))if(current[key]!=null)throw new Error('Translated label is no longer null');
}

/** Local/release-operator primitive. No CLI or cloud activation is provided:
 * the caller must validate the exact connection and reviewed media package.
 * Complete preflight precedes writes; every bounded chunk is rechecked locked.
 */
export async function importCoreReferences(sql, input, {dryRun=true}={}) {
  const pkg=validateReferencePackage(input), report={batchId:pkg.sha256,dryRun,inserted:0,filled:0,resumed:0,preserved:0};
  await transaction(sql,async tx=>{
    for(const group of pkg.tables){
      const current=await currentRows(tx,group.table,group.rows.map(r=>r.targetId),false,pkg.sha256);
      const receipts=await tx`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table}`;
      const prior=new Map(receipts.map(r=>[r.row_id,r]));
      for(const row of group.rows){checkRow(row,current.get(row.targetId),prior.get(row.targetId));if(row.disposition==='preserve')report.preserved++;}
    }
  },true);
  if(dryRun)return {...report,insertionsPlanned:pkg.tables.reduce((n,g)=>n+g.rows.filter(r=>r.disposition==='insert').length,0),fillsPlanned:pkg.tables.reduce((n,g)=>n+g.rows.filter(r=>r.disposition==='fill-null-labels').length,0)};
  await transaction(sql,async tx=>{
    await tx`INSERT INTO reference_release_batches(id,source_project,target_project,policy) VALUES(${pkg.sha256},${pkg.sourceProject},${pkg.targetProject},${pkg.policy}) ON CONFLICT(id) DO NOTHING`;
    const row=(await tx`SELECT * FROM reference_release_batches WHERE id=${pkg.sha256}`)[0];
    if(row.source_project!==pkg.sourceProject||row.target_project!==pkg.targetProject||row.policy!==pkg.policy)throw new Error('Batch metadata conflict');
  });
  for(const group of pkg.tables){
    const changes=group.rows.filter(r=>r.disposition!=='preserve');
    const allowedColumns=new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${group.table}`).map(r=>r.column_name));
    for(let i=0;i<changes.length;i+=100)await transaction(sql,async tx=>{
      const chunk=changes.slice(i,i+100),ids=chunk.map(r=>r.targetId);
      const current=await currentRows(tx,group.table,ids,true,pkg.sha256);
      const receipts=await tx`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=ANY(${tx.array(ids)}::uuid[])`;
      const prior=new Map(receipts.map(r=>[r.row_id,r]));const fresh=[];
      for(const row of chunk){checkRow(row,current.get(row.targetId),prior.get(row.targetId));if(prior.has(row.targetId)){report.resumed++;continue;}fresh.push(row);}
      const inserts=fresh.filter(r=>r.disposition==='insert');
      if(inserts.length){
        const columns=Object.keys(inserts[0].insert).sort();
        if(columns.some(k=>!allowedColumns.has(k))||inserts.some(r=>Object.keys(r.insert).sort().join(',')!==columns.join(',')))throw new Error('Unknown or inconsistent insert columns');
        const names=columns.map(quote).join(',');
        const inserted=await tx.unsafe(`INSERT INTO public.${group.table} AS t (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::public.${group.table},$1::jsonb) RETURNING to_jsonb(t) AS row`,[inserts.map(r=>r.insert)]);
        await tx`INSERT INTO reference_release_rows ${tx(inserted.map(({row})=>({batch_id:pkg.sha256,table_name:group.table,row_id:row.id,operation:'insert',before_data:null,after_data:tx.json(row)})))}`;
        report.inserted+=inserted.length;
      }
      for(const row of fresh.filter(r=>r.disposition==='fill-null-labels')){
        const columns=Object.keys(row.fill);if(columns.some(k=>!allowedColumns.has(k)))throw new Error('Unknown label column');
        const values=columns.map(k=>row.fill[k]);values.push(row.targetId);
        const updated=await tx.unsafe(`UPDATE public.${group.table} AS t SET ${columns.map((k,j)=>quote(k)+'=$'+(j+1)).join(',')} WHERE id=$${values.length} RETURNING to_jsonb(t) AS row`,values);
        await tx`INSERT INTO reference_release_rows(batch_id,table_name,row_id,operation,before_data,after_data) VALUES(${pkg.sha256},${group.table},${row.targetId},'fill-null-labels',${tx.json(current.get(row.targetId))},${tx.json(updated[0].row)})`;
        report.filled++;
      }
    });
  }
  return report;
}

/** Retains every inserted reference. Only our unchanged label fills are
 * restored. Changed/published rows are retained and explicitly require review.
 * Dependent new modes must be disabled before rollback; no live history is deleted.
 */
export async function undoCoreReferences(sql,input,{dryRun=true}={}) {
  const pkg=validateReferencePackage(input),report={batchId:pkg.sha256,dryRun,retainedInsertions:0,restoredLabels:0,alreadyUndone:0,needsReview:0};
  for(const group of [...pkg.tables].reverse()){
    const rows=await sql`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table} ORDER BY row_id`;
    for(let i=0;i<rows.length;i+=100)await transaction(sql,async tx=>{
      for(const receipt of rows.slice(i,i+100)){
        const latest=(await tx`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=${receipt.row_id}`)[0];
        if(latest.undone_at){report.alreadyUndone++;continue;}
        const current=(await currentRows(tx,group.table,[receipt.row_id],!dryRun)).get(receipt.row_id);
        const [original]=await rowsBeforeMediaBindings(tx,pkg.sha256,group.table,current?[current]:[]);
        if(!current||!same(original,latest.after_data)){report.needsReview++;continue;}
        let after=current;
        if(latest.operation==='insert')report.retainedInsertions++;
        else{
          const row=group.rows.find(r=>r.targetId===receipt.row_id),keys=Object.keys(row.fill);report.restoredLabels++;
          if(!dryRun){const args=keys.map(k=>latest.before_data[k]);args.push(receipt.row_id);after=(await tx.unsafe(`UPDATE public.${group.table} AS t SET ${keys.map((k,j)=>quote(k)+'=$'+(j+1)).join(',')} WHERE id=$${args.length} RETURNING to_jsonb(t) row`,args))[0].row;}
        }
        if(!dryRun)await tx`UPDATE reference_release_rows SET undo_data=${tx.json(after)},undone_at=now() WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=${receipt.row_id}`;
      }
    },dryRun);
  }
  return report;
}
