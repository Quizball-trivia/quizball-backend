import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import {buildReleaseMediaPlan,validateReleaseMediaPlan,preserveReleaseMedia,productionMediaStorage}from'../../scripts/release/release-media.mjs';
import{contentHash}from'../../scripts/release/question-manifest.mjs';
const data=Buffer.from('preserved original image'),sha256=createHash('sha256').update(data).digest('hex');
const input=url=>({url,sha256,bytes:data.length,contentType:'image/webp'});
const build=()=>buildReleaseMediaPlan([input('https://example.com/a'),input('https://example.com/b')],{sourceReceiptSha256:'1'.repeat(64),releaseSha256:'2'.repeat(64)});
test('deduplicates identical bytes while retaining every source URL; rejects changed destination even with a new hash',()=>{
 const p=build();assert.equal(p.objects.length,1);assert.equal(p.objects[0].sourceUrls.length,2);assert.match(p.objects[0].key,/^releases\/2{64}\/[a-f0-9]{64}\.webp$/);validateReleaseMediaPlan(p,p.sha256);
 p.objects[0].key='existing-live-image.webp';const{sha256,...body}=p;p.sha256=contentHash(body);assert.throws(()=>validateReleaseMediaPlan(p,p.sha256),/destinations/);
});
test('refuses oversized files and ambiguous archives',()=>{
 assert.throws(()=>buildReleaseMediaPlan([{...input('https://example.com/a'),bytes:10485761}],{sourceReceiptSha256:'1'.repeat(64),releaseSha256:'2'.repeat(64)}),/size bound/);
 assert.throws(()=>buildReleaseMediaPlan([input('https://example.com/a'),{...input('https://example.com/a'),sha256:'f'.repeat(64)}],{sourceReceiptSha256:'1'.repeat(64),releaseSha256:'2'.repeat(64)}),/differing archived/);
});
test('validates all source bytes before any write; dry run never contacts storage',async()=>{
 const p=build();let contacted=0;const storage={read:async()=>{contacted++;return null;},create:async()=>{contacted++;return'created';}};
 await preserveReleaseMedia({plan:p,expectedSha256:p.sha256,loadBytes:async()=>data,storage});assert.equal(contacted,0);
 await assert.rejects(preserveReleaseMedia({plan:p,expectedSha256:p.sha256,loadBytes:async()=>Buffer.from('bad'),storage,dryRun:false}),/Archived media/);assert.equal(contacted,0);
});
test('resumes after upload response loss by comparing remote bytes; never overwrites a collision',async()=>{
 const p=build();let remote=null,writes=0,receipts=[];
 const storage={read:async()=>remote,create:async()=>{if(remote)return'exists';writes++;remote={bytes:data,contentType:'image/webp'};throw new Error('response lost');}};
 const args={plan:p,expectedSha256:p.sha256,loadBytes:async()=>data,storage,dryRun:false,onVerified:async r=>receipts.push(r)};
 await assert.rejects(preserveReleaseMedia(args),/response lost/);assert.equal(writes,1);
 const retry=await preserveReleaseMedia(args);assert.equal(retry.resumed,1);assert.equal(retry.verified,1);assert.equal(writes,1);assert.equal(receipts.length,1);
 remote={bytes:Buffer.alloc(data.length,1),contentType:'image/webp'};await assert.rejects(preserveReleaseMedia(args),/never overwrite/);assert.equal(writes,1);
});
test('fixed production adapter refuses an arbitrary public URL or path before fetching',async()=>{
 const storage=productionMediaStorage('local-test-token-never-sent-123456789');const p=build();
 await assert.rejects(storage.read({...p.objects[0],publicUrl:'https://example.com/steal'}),/origin differs/);
 await assert.rejects(storage.create({...p.objects[0],key:'../live.webp'},data),/namespace/);
});
test('retries a temporary verification failure without overwriting; honors retry-after',async()=>{
 const p=build();let remote=null,reads=0,writes=0;const delays=[];
 const storage={create:async()=>{if(remote)return'exists';remote={bytes:data,contentType:'image/webp'};writes++;return'created';},read:async()=>{if(reads++===0)throw Object.assign(new Error('HTTP 502'),{retryable:true,retryAfterMs:7000});return remote;}};
 const result=await preserveReleaseMedia({plan:p,expectedSha256:p.sha256,loadBytes:async()=>data,storage,dryRun:false,wait:async ms=>delays.push(ms)});
 assert.equal(result.verified,1);assert.equal(result.retries,1);assert.equal(writes,1);assert.deepEqual(delays,[7000]);
});
test('bounds temporary retries and refuses to shorten a long server backoff',async()=>{
 const p=build();let calls=0,delays=0;
 const args={plan:p,expectedSha256:p.sha256,loadBytes:async()=>data,dryRun:false,wait:async()=>{delays++;},storage:{create:async()=>{calls++;throw Object.assign(new Error('HTTP 503'),{retryable:true});}}};
 await assert.rejects(preserveReleaseMedia(args),/HTTP 503/);assert.equal(calls,4);assert.equal(delays,3);
 calls=0;delays=0;args.storage.create=async()=>{calls++;throw Object.assign(new Error('HTTP 429'),{retryable:true,retryAfterMs:300000});};
 await assert.rejects(preserveReleaseMedia(args),/HTTP 429/);assert.equal(calls,1);assert.equal(delays,0);
});
