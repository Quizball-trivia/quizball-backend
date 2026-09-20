import {createHash} from 'node:crypto';
import {contentHash} from './question-manifest.mjs';
const PROD='lfbwhxvwubzeqkztghok';
const ORIGIN=`https://${PROD}.supabase.co`;
const TYPES={'image/png':['imgs','png',10485760],'image/jpeg':['imgs','jpg',10485760],'image/webp':['imgs','webp',10485760],'image/svg+xml':['imgs','svg',10485760],'video/mp4':['goal-clips','mp4',52428800]};
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Content-addressed, additive destinations. No existing public object path is reused. */
export function buildReleaseMediaPlan(receipts,{sourceReceiptSha256,releaseSha256}){
 if(!digest(sourceReceiptSha256)||!digest(releaseSha256)||!Array.isArray(receipts)||!receipts.length)throw new Error('Pinned source receipts and release required');
 const byObject=new Map(),byUrl=new Map();
 for(const row of receipts){
  const type=TYPES[row.contentType];
  if(!type||!digest(row.sha256)||!Number.isSafeInteger(row.bytes)||row.bytes<=0||row.bytes>type[2])throw new Error('Media type, digest or bucket size bound is invalid');
  const source=new URL(row.url);if(source.protocol!=='https:'||source.username||source.password)throw new Error('Invalid source media URL');
  const key=`releases/${releaseSha256}/${row.sha256}.${type[1]}`,identity=type[0]+'/'+key;
  if(byUrl.has(row.url)&&byUrl.get(row.url)!==identity)throw new Error('Source URL has differing archived bytes');
  byUrl.set(row.url,identity);
  let object=byObject.get(identity);
  if(!object){object={bucket:type[0],key,sha256:row.sha256,bytes:row.bytes,contentType:row.contentType,sourceUrls:[],publicUrl:`${ORIGIN}/storage/v1/object/public/${identity}`};byObject.set(identity,object);}
  if(object.bytes!==row.bytes||object.contentType!==row.contentType)throw new Error('Conflicting object metadata');
  if(!object.sourceUrls.includes(row.url))object.sourceUrls.push(row.url);
 }
 const body={format:1,targetProject:PROD,releaseSha256,sourceReceiptSha256,policy:'create-only; byte-verified; retain-on-undo',objects:[...byObject.values()].sort((a,b)=>a.publicUrl.localeCompare(b.publicUrl))};
 for(const row of body.objects)row.sourceUrls.sort();
 return {...body,sha256:contentHash(body)};
}
export function validateReleaseMediaPlan(plan,expectedSha256){
 const {sha256,...body}=plan;
 if(!digest(expectedSha256)||sha256!==expectedSha256||contentHash(body)!==sha256||plan.targetProject!==PROD||plan.format!==1)throw new Error('Pinned production media plan required');
 const rebuilt=buildReleaseMediaPlan(plan.objects.flatMap(row=>row.sourceUrls.map(url=>({url,sha256:row.sha256,bytes:row.bytes,contentType:row.contentType}))),plan);
 if(rebuilt.sha256!==sha256)throw new Error('Media destinations or policy differ from the pinned namespace');
 return plan;
}

/** The caller provides verified local bytes. Every file is checked before the first
 * remote write. A retry checks the public bytes again, including pre-existing keys.
 * This primitive deliberately has no deletion or overwrite operation.
 */
export async function preserveReleaseMedia({plan,expectedSha256,loadBytes,storage,onVerified=async()=>{},dryRun=true,concurrency=3,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 validateReleaseMediaPlan(plan,expectedSha256);
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Bounded media concurrency required');
 const local=async row=>{const bytes=await loadBytes(row);if(bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error('Archived media bytes do not match the plan');return bytes;};
 for(const row of plan.objects)await local(row);
 const report={planSha256:plan.sha256,dryRun,objects:plan.objects.length,sourceUrls:plan.objects.reduce((n,r)=>n+r.sourceUrls.length,0),uploaded:0,resumed:0,verified:0,retries:0,deleted:0};
 if(dryRun)return report;
 let index=0,failed;
 async function transfer(row){for(let attempt=0;attempt<4;attempt++)try{
  // Create-only POST handles an existing key atomically. A speculative GET
  // before every new object adds latency without protecting against races.
  const result=await storage.create(row,await local(row));
  if(!['created','exists'].includes(result))throw new Error('Unexpected create result');
  const current=await storage.read(row);
  if(!current||current.bytes.length!==row.bytes||hash(current.bytes)!==row.sha256||current.contentType!==row.contentType)throw new Error('Destination media differs; never overwrite it');
  await onVerified({bucket:row.bucket,key:row.key,publicUrl:row.publicUrl,sha256:row.sha256,bytes:row.bytes,contentType:row.contentType,planSha256:plan.sha256,verifiedAt:new Date().toISOString()});report.verified++;report[result==='created'?'uploaded':'resumed']++;return;
 }catch(error){
  const transient=error.retryable||['TimeoutError','AbortError'].includes(error.name)||/^(ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_)/.test(error.cause?.code??'');
  const delay=Math.max(1000*3**attempt,error.retryAfterMs??0);
  if(!transient||attempt===3||delay>120000)throw error;
  report.retries++;await wait(delay);
 }}
 async function worker(){while(!failed&&index<plan.objects.length){const row=plan.objects[index++];try{await transfer(row);}catch(error){failed??=error;}}}
 await Promise.all(Array.from({length:concurrency},worker));if(failed)throw failed;
 return report;
}

/** Production origin is fixed; credentials are never sent on a redirect or public GET. */
export function productionMediaStorage(serviceRoleKey){
 if(typeof serviceRoleKey!=='string'||serviceRoleKey.length<30)throw new Error('Production Storage credential required');
 let notBefore=0;
 async function request(url,options,timeoutMs=60000){
  while(Date.now()<notBefore){
   const remaining=notBefore-Date.now();
   if(remaining>120000)throw Object.assign(new Error('Storage rate-limit backoff is still active'),{retryable:true,retryAfterMs:remaining});
   await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,30000)));
  }
  return fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
 }
 function location(row){
  const type=TYPES[row.contentType];
  if(!type||row.bucket!==type[0]||!new RegExp(`^releases/[a-f0-9]{64}/${row.sha256}\\.${type[1]}$`).test(row.key)||!digest(row.sha256))throw new Error('Media key outside release namespace');
  return `${ORIGIN}/storage/v1/object/${row.bucket}/${row.key}`;
 }
 async function bytes(response,row){
  if(Number(response.headers.get('content-length'))>row.bytes)throw new Error('Destination exceeds expected size');
  const chunks=[];let total=0;for await(const block of response.body){total+=block.length;if(total>row.bytes)throw new Error('Destination exceeds expected size');chunks.push(block);}return Buffer.concat(chunks);
 }
 function httpError(response,operation){
  const error=new Error(operation+': HTTP '+response.status);error.retryable=[408,429].includes(response.status)||response.status>=500;
  const value=response.headers.get('retry-after');
  error.retryAfterMs=value&&/^\d+$/.test(value)?Number(value)*1000:Math.max(0,Date.parse(value??'')-Date.now())||0;
  if(response.status===429)notBefore=Math.max(notBefore,Date.now()+Math.max(1000,error.retryAfterMs));
  return error;
 }
 const storage = {
  async read(row){
   location(row);const expected=`${ORIGIN}/storage/v1/object/public/${row.bucket}/${row.key}`;if(row.publicUrl!==expected)throw new Error('Public media origin differs');
   const response=await request(expected,{redirect:'error',headers:{'Cache-Control':'no-cache'}},row.contentType==='video/mp4'?600000:60000);
   if(response.status===404||response.status===400){
    // Storage reports a missing object as 400 with this specific error code.
    const error=await response.json().catch(()=>null);if(response.status===404||['not_found','NoSuchKey'].includes(error?.error)||error?.statusCode==='404')return null;
    throw httpError(response,'Public media read failed');
   }
   if(!response.ok)throw httpError(response,'Public media read failed');
   return {bytes:await bytes(response,row),contentType:response.headers.get('content-type')?.split(';')[0]};
  },
  async create(row,body){
   const url=location(row);if(body.length!==row.bytes||hash(body)!==row.sha256)throw new Error('Upload bytes changed');
   // Large videos may have completed uploading before a public verification
   // timed out. Verify that object before sending the entire video again.
   if(row.contentType==='video/mp4'){
    const existing=await storage.read(row);
    if(existing){
     if(existing.bytes.length!==row.bytes||hash(existing.bytes)!==row.sha256||existing.contentType!==row.contentType)throw new Error('Existing video differs; never overwrite it');
     return 'exists';
    }
   }
   const response=await request(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${serviceRoleKey}`,apikey:serviceRoleKey,'Content-Type':row.contentType,'Cache-Control':'public, max-age=31536000, immutable','x-upsert':'false'},body},row.contentType==='video/mp4'?600000:120000);
   if(response.ok){await response.arrayBuffer();return 'created';}
   const error=await response.json().catch(()=>null);if([400,409].includes(response.status)&&['Duplicate','AssetAlreadyExists','ResourceAlreadyExists'].includes(error?.error))return 'exists';
   throw httpError(response,'Create-only media upload failed');
  },
 };
 return storage;
}
