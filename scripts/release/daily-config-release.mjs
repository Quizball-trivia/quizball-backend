import {contentHash} from './question-manifest.mjs';
const FIELDS=['challenge_type','is_active','sort_order','show_on_home','coin_reward','xp_reward','settings'];
const TYPES=['moneyDrop','trueFalse','clues','countdown','putInOrder','imposter','careerPath','highLow','footballLogic','fifaCards','cardDetective','missingXi','passChain','statSniper'];
const same=(a,b)=>contentHash(a)===contentHash(b);
const pick=row=>row==null?null:Object.fromEntries(FIELDS.map(k=>[k,row[k]]));
const uuid=s=>{const h=contentHash(s);return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-');};
export function buildDailyConfigPlan(source,target,{verificationSha256}){
 if(!/^[a-f0-9]{64}$/.test(verificationSha256))throw Error('Verified source evidence required');
 const before=new Map(target.map(r=>[r.challenge_type,r])),seen=new Set(),rows=[];
 for(const item of source){const type=item.challenge_type;
  if(!TYPES.includes(type)||seen.has(type))throw Error('Unexpected or duplicate daily challenge');seen.add(type);
  const after=pick(item),old=pick(before.get(type));
  if(typeof after.is_active!=='boolean'||typeof after.show_on_home!=='boolean'||!['sort_order','coin_reward','xp_reward'].every(k=>Number.isSafeInteger(after[k])&&after[k]>=0)||!after.settings||Array.isArray(after.settings))throw Error('Invalid daily configuration');
  if(!same(old,after))rows.push({id:uuid(type),type,before:old,after});
 }
 const body={format:1,sourceProject:'nsdfiprfmhdqhbfxfwpv',targetProject:'lfbwhxvwubzeqkztghok',policy:'reviewed-daily-settings; before-images; disable-new-on-undo',verificationSha256,rows:rows.sort((a,b)=>a.type.localeCompare(b.type))};
 return {...body,sha256:contentHash(body)};
}
export async function applyDailyConfigPlan(sql,plan,{dryRun=true,undo=false}={}){
 const {sha256,...body}=plan;
 if(contentHash(body)!==sha256||plan.targetProject!=='lfbwhxvwubzeqkztghok'||plan.sourceProject!=='nsdfiprfmhdqhbfxfwpv')throw Error('Pinned production daily plan required');
 const rebuilt=buildDailyConfigPlan(plan.rows.map(r=>r.after),plan.rows.flatMap(r=>r.before?[r.before]:[]),plan);
 if(rebuilt.sha256!==sha256)throw Error('Daily configuration scope differs');
 return sql.begin(dryRun?'ISOLATION LEVEL REPEATABLE READ READ ONLY':'',async tx=>{
  await tx`SET LOCAL lock_timeout='2s'`;await tx`SET LOCAL statement_timeout='30s'`;await tx`SET LOCAL timezone='UTC'`;
  if(!dryRun)await tx`SELECT pg_advisory_xact_lock(20260920,120418)`;
  const [batch]=await tx`SELECT * FROM reference_release_batches WHERE id=${sha256}`;
  if(batch&&(batch.source_project!==plan.sourceProject||batch.target_project!==plan.targetProject||batch.policy!==plan.policy))throw Error('Daily configuration batch differs');
  const report={batchId:sha256,dryRun,undo,changed:0,resumed:0,deletedRows:0};
  const current=new Map((await tx`SELECT to_jsonb(c) AS row FROM daily_challenge_configs c WHERE challenge_type=ANY(${tx.array(plan.rows.map(r=>r.type))}::text[]) ${dryRun?tx``:tx`FOR UPDATE`}`).map(r=>[r.row.challenge_type,r.row]));
  const prior=new Map((await tx`SELECT * FROM reference_release_rows WHERE batch_id=${sha256} AND table_name='daily_challenge_configs'`).map(r=>[r.row_id,r]));
  const changes=[];
  for(const row of plan.rows){const now=current.get(row.type)??null,receipt=prior.get(row.id);
   if(receipt&&(receipt.operation!=='publish'||!same(pick(receipt.before_data),row.before)))throw Error('Daily receipt differs');
   if(undo){
    if(!receipt)throw Error('No daily change to undo');
    if(receipt.undone_at){if(!same(now,receipt.undo_data))throw Error('Daily config changed after undo');report.resumed++;continue;}
    if(!same(now,receipt.after_data))throw Error('Later daily editor change; undo refused');
    changes.push({row,now,to:row.before??{...row.after,is_active:false,show_on_home:false}});
   }else{
    if(receipt?.undone_at)throw Error('Undone daily release cannot be reapplied');
    if(receipt){if(!same(now,receipt.after_data))throw Error('Published daily config edited');report.resumed++;continue;}
    if(!same(pick(now),row.before))throw Error('Daily config changed since review');
    changes.push({row,now,to:row.after});
   }
  }
  report.changed=changes.length;if(dryRun||!changes.length)return report;
  if(!undo)await tx`INSERT INTO reference_release_batches(id,source_project,target_project,policy) VALUES(${sha256},${plan.sourceProject},${plan.targetProject},${plan.policy}) ON CONFLICT(id) DO NOTHING`;
  for(const {row,now,to}of changes){
   let after;
   if(now)[{row:after}]=await tx`UPDATE daily_challenge_configs c SET is_active=${to.is_active},sort_order=${to.sort_order},show_on_home=${to.show_on_home},coin_reward=${to.coin_reward},xp_reward=${to.xp_reward},settings=${tx.json(to.settings)} WHERE challenge_type=${row.type} RETURNING to_jsonb(c) AS row`;
   else [{row:after}]=await tx`INSERT INTO daily_challenge_configs ${tx({...to,settings:tx.json(to.settings)})} RETURNING to_jsonb(daily_challenge_configs) AS row`;
   if(!after||!same(pick(after),to))throw Error('Daily configuration verification failed');
   if(undo)await tx`UPDATE reference_release_rows SET undo_data=${tx.json(after)},undone_at=now() WHERE batch_id=${sha256} AND table_name='daily_challenge_configs' AND row_id=${row.id}`;
   else await tx`INSERT INTO reference_release_rows(batch_id,table_name,row_id,operation,before_data,after_data) VALUES(${sha256},'daily_challenge_configs',${row.id},'publish',${now?tx.json(now):null},${tx.json(after)})`;
  }
  return report;
 });
}
