import {contentHash} from './question-manifest.mjs';
const PROD='lfbwhxvwubzeqkztghok',STAGE='nsdfiprfmhdqhbfxfwpv';
const KEYS={football_player_name_translations:['football_player_id','locale'],player_season_snapshots:['id']};
const same=(a,b)=>a!==undefined&&b!==undefined&&contentHash(a)===contentHash(b);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const identity=(table,row)=>contentHash(KEYS[table].map(k=>row[k]));
const uuid=hash=>[hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
const journalId=(table,row)=>row.id??uuid(identity(table,row));
const natural=(table,row)=>table==='player_season_snapshots'?contentHash([row.football_player_id,row.season_start_year]):identity(table,row);
// Source exporters and PostgreSQL JSON may spell equivalent UTC dates differently.
const comparable=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,['created_at','updated_at','reviewed_at'].includes(k)&&v?new Date(v).toISOString():v]));
export function buildCatalogueReferencePackage(source,target,{sourceProject=STAGE,targetProject=PROD,sourceEvidenceSha256,targetEvidenceSha256}){
 if(![PROD,STAGE].includes(sourceProject)||![PROD,STAGE].includes(targetProject)||sourceProject===targetProject||![sourceEvidenceSha256,targetEvidenceSha256].every(x=>/^[a-f0-9]{64}$/.test(x??'')))throw new Error('Pinned catalogue source, target and evidence required');
 const tables=[];
 for(const table of Object.keys(KEYS)){
  if(!Array.isArray(source[table])||!Array.isArray(target[table]))throw new Error('Complete catalogue table inventories required');
  const originals=new Map(),naturalKeys=new Map();
  for(const row of target[table]){const key=identity(table,row),nk=natural(table,row);if(originals.has(key)||naturalKeys.has(nk))throw new Error('Duplicate target identity');originals.set(key,row);naturalKeys.set(nk,key);}
  const seen=new Set(),sourceNatural=new Set(),rows=[];
  for(const input of source[table]){
   const row=structuredClone(input),key=identity(table,row),nk=natural(table,row);
   if(KEYS[table].some(k=>row[k]==null)||!row.football_player_id||seen.has(key)||sourceNatural.has(nk))throw new Error('Invalid or duplicate source identity');seen.add(key);sourceNatural.add(nk);
   if(!originals.has(key)&&naturalKeys.has(nk))throw new Error('Different source UUID shares an existing catalogue identity');
   const before=originals.get(key);
   // Conflicts remain exactly as production stores them; no updates are emitted.
   rows.push({key,journalId:journalId(table,row),disposition:before?'preserve':'insert',row:before??row});
  }
  rows.sort((a,b)=>a.key.localeCompare(b.key));tables.push({table,rows,originalRows:target[table]});
 }
 const body={format:1,sourceProject,targetProject,sourceEvidenceSha256,targetEvidenceSha256,policy:'add-only; preserve-target; retain-all-on-undo',tables};
 return {...body,sha256:contentHash(body)};
}
export function validateCatalogueReferencePackage(pkg){
 const{sha256,...body}=pkg;if(!/^[a-f0-9]{64}$/.test(sha256??'')||contentHash(body)!==sha256)throw new Error('Catalogue package checksum differs');
 if(pkg.tables.length!==Object.keys(KEYS).length||new Set(pkg.tables.map(t=>t.table)).size!==pkg.tables.length||pkg.tables.some(t=>!Object.hasOwn(KEYS,t.table)))throw new Error('Unexpected catalogue table');
 const source=Object.fromEntries(pkg.tables.map(t=>[t.table,t.rows.map(r=>r.row)])),target=Object.fromEntries(pkg.tables.map(t=>[t.table,t.originalRows]));
 if(buildCatalogueReferencePackage(source,target,pkg).sha256!==sha256)throw new Error('Catalogue identity or preservation policy differs');return pkg;
}
async function transaction(sql,fn,readOnly=false){return sql.begin(readOnly?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
 await tx`SET LOCAL timezone='UTC'`;await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='60s'`;
 if(!readOnly)await tx`SELECT pg_advisory_xact_lock(20260919,63255)`;return fn(tx);
});}
async function readRows(tx,table,rows,lock){
 const current=await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t JOIN jsonb_populate_recordset(NULL::public.${table},$1::jsonb) s ON ${KEYS[table].map(k=>'t.'+quote(k)+'=s.'+quote(k)).join(' AND ')}${lock?' FOR UPDATE OF t':''}`,[rows]);
 return new Map(current.map(r=>[identity(table,r.row),r.row]));
}
/** Caller must pin the target connection. All writes are additions, and every
 * bounded transaction rechecks its source identities under row locks. */
export async function importCatalogueReferences(sql,input,{dryRun=true}={}){
 const pkg=validateCatalogueReferencePackage(input),report={batchId:pkg.sha256,dryRun,inserted:0,preserved:0,resumed:0};
 async function check(tx,group,chunk,locked){
  const current=await readRows(tx,group.table,chunk.map(r=>r.row),locked);
  const receipts=await tx`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=ANY(${tx.array(chunk.map(r=>r.journalId))}::uuid[])`;
  const saved=new Map(receipts.map(r=>[r.row_id,r])),fresh=[];
  for(const row of chunk){const value=current.get(row.key),prior=saved.get(row.journalId);
   if(row.disposition==='preserve'){if(!value||!same(comparable(value),comparable(row.row)))throw new Error('Original catalogue content changed');report.preserved++;continue;}
   if(prior){if(prior.undone_at)throw new Error('An undone catalogue batch cannot be reapplied');if(!value||!same(value,prior.after_data))throw new Error('Imported catalogue content was edited');report.resumed++;continue;}
   if(value)throw new Error('Catalogue identity appeared after snapshot; overwrite refused');fresh.push(row);
  }return fresh;
 }
 await transaction(sql,async tx=>{
  const [batch]=await tx`SELECT * FROM reference_release_batches WHERE id=${pkg.sha256}`;
  if(batch&&(batch.source_project!==pkg.sourceProject||batch.target_project!==pkg.targetProject||batch.policy!==pkg.policy))throw new Error('Catalogue batch metadata differs');
  for(const group of pkg.tables)for(let i=0;i<group.rows.length;i+=100){const fresh=await check(tx,group,group.rows.slice(i,i+100),false);if(dryRun)report.inserted+=fresh.length;}
 },true);
 if(dryRun)return report;report.preserved=0;report.resumed=0;
 await transaction(sql,tx=>tx`INSERT INTO reference_release_batches(id,source_project,target_project,policy) VALUES(${pkg.sha256},${pkg.sourceProject},${pkg.targetProject},${pkg.policy}) ON CONFLICT(id) DO NOTHING`);
 for(const group of pkg.tables)for(let i=0;i<group.rows.length;i+=100)await transaction(sql,async tx=>{
  const fresh=await check(tx,group,group.rows.slice(i,i+100),true);if(!fresh.length)return;
  const columns=Object.keys(fresh[0].row).sort();if(fresh.some(r=>Object.keys(r.row).sort().join(',')!==columns.join(',')))throw new Error('Inconsistent catalogue columns');
  const names=columns.map(quote).join(',');const inserted=await tx.unsafe(`INSERT INTO public.${group.table} AS t (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::public.${group.table},$1::jsonb) RETURNING to_jsonb(t) AS row`,[fresh.map(r=>r.row)]);
  if(inserted.length!==fresh.length)throw new Error('Catalogue insert count differs');
  await tx`INSERT INTO reference_release_rows ${tx(inserted.map(({row})=>({batch_id:pkg.sha256,table_name:group.table,row_id:journalId(group.table,row),operation:'insert',before_data:null,after_data:tx.json(row)})))}`;
  report.inserted+=inserted.length;
 });return report;
}
/** Catalogue rollback retains every row, including edits and game references.
 * Disable dependent new modes before rolling back code. No content is deleted. */
export async function retainCatalogueReferences(sql,input,{dryRun=true}={}){
 const pkg=validateCatalogueReferencePackage(input),report={batchId:pkg.sha256,dryRun,retained:0,alreadyUndone:0,needsReview:0,deletedRows:0};
 for(const group of pkg.tables){const additions=group.rows.filter(r=>r.disposition==='insert');
  for(let i=0;i<additions.length;i+=100)await transaction(sql,async tx=>{
   const chunk=additions.slice(i,i+100),current=await readRows(tx,group.table,chunk.map(r=>r.row),!dryRun);
   const receipts=await tx`SELECT * FROM reference_release_rows WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=ANY(${tx.array(chunk.map(r=>r.journalId))}::uuid[])`;
   const prior=new Map(receipts.map(r=>[r.row_id,r])),unchanged=[];
   for(const row of chunk){const receipt=prior.get(row.journalId);if(!receipt)continue;if(receipt.undone_at){report.alreadyUndone++;continue;}
    const value=current.get(row.key);if(!same(value,receipt.after_data)){report.needsReview++;continue;}report.retained++;
    unchanged.push(row.journalId);
   }
   if(!dryRun&&unchanged.length)await tx`UPDATE reference_release_rows SET undo_data=after_data,undone_at=now() WHERE batch_id=${pkg.sha256} AND table_name=${group.table} AND row_id=ANY(${tx.array(unchanged)}::uuid[])`;
  },dryRun);
 }return report;
}
