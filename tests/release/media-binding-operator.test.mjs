import test from 'node:test';import assert from 'node:assert/strict';
import {buildReleaseMediaPlan} from '../../scripts/release/release-media.mjs';
import {buildMediaBindingPlan,verifiedMediaUrlMap} from '../../scripts/release/content-media-bindings.mjs';
import {checkMediaBindingPacket} from '../../scripts/release/media-binding-operator.mjs';
import {verifyImageDimensionCorrections,runMediaBindings} from '../../scripts/release/media-binding-operator.mjs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const prod='lfbwhxvwubzeqkztghok',stage='nsdfiprfmhdqhbfxfwpv',source=`https://${stage}.supabase.co/storage/v1/object/public/imgs/source.webp`;
function packet(){
 const media=buildReleaseMediaPlan([{url:source,sha256:'1'.repeat(64),bytes:16,contentType:'image/webp'}],{sourceReceiptSha256:'2'.repeat(64),releaseSha256:'3'.repeat(64)});
 const receipts=media.objects.map(r=>({...r,verifiedAt:'2026-09-19T23:00:00Z'}));
 const verified=verifiedMediaUrlMap([media],receipts);
 const plan=buildMediaBindingPlan([{table:'football_players',contentBatchId:'4'.repeat(64),before:{id:'00000000-0000-4000-8000-000000000001',image_url:source}}],{targetProject:prod,...verified});
 return {databaseUrl:`postgresql://postgres.${prod}@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`,plan,expectedSha256:plan.sha256,mediaPlans:[media],destinationReceipts:receipts};
}
test('read-only packet pins project, session connection and verified bytes',()=>{
 const p=packet();assert.equal(checkMediaBindingPacket(p).dryRun,true);
 assert.throws(()=>checkMediaBindingPacket({...p,databaseUrl:p.databaseUrl.replace(prod,stage)}),/exact/);
 assert.throws(()=>checkMediaBindingPacket({...p,databaseUrl:p.databaseUrl.replace(':5432',':6543')}),/transaction/);
 assert.throws(()=>checkMediaBindingPacket({...p,databaseUrl:p.databaseUrl.replace('?sslmode=require','')}),/Encrypted/);
 assert.throws(()=>checkMediaBindingPacket({...p,destinationReceipts:[]}),/incomplete/);
 assert.throws(()=>checkMediaBindingPacket({...p,allowStagingOriginals:true}),/production/);
});
test('cloud writes and undo require recovery and rehearsal evidence before connecting',()=>{
 const p=packet();for(const action of ['apply','undo']){
 assert.throws(()=>checkMediaBindingPacket({...p,action}),/recovery/);
 const ready={...p,action,evidence:{fullRestoreVerified:true,backupSha256:'5'.repeat(64),reservationSha256:'6'.repeat(64),rehearsalSha256:'7'.repeat(64)}};
 assert.equal(checkMediaBindingPacket(ready).dryRun,false);assert.equal(checkMediaBindingPacket(ready).undo,action==='undo');
 }
});
test('local rehearsal cannot be enabled for a cloud or ordinary local database',()=>{
 const p=packet();assert.throws(()=>checkMediaBindingPacket({...p,rehearsal:true}),/Isolated/);
 assert.throws(()=>checkMediaBindingPacket({...p,rehearsal:true,databaseUrl:'postgresql://postgres@127.0.0.1:5432/postgres'}),/Isolated/);
 const local={...p,rehearsal:true,databaseUrl:'postgresql://postgres@127.0.0.1:55519/rehearsal_media',action:'apply'};
 assert.equal(checkMediaBindingPacket(local).dryRun,false);
});

test('dimension repairs decode the archived bytes and reject fabricated dimensions before connecting',async()=>{
 const bytes=await sharp({create:{width:12,height:7,channels:3,background:'#ffffff'}}).png().toBuffer();
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const media=buildReleaseMediaPlan([{url:source,sha256,bytes:bytes.length,contentType:'image/png'}],{sourceReceiptSha256:'2'.repeat(64),releaseSha256:'3'.repeat(64)});
 const receipts=media.objects.map(r=>({...r,verifiedAt:'2026-09-19T23:00:00Z'})),verified=verifiedMediaUrlMap([media],receipts);
 const make=width=>buildMediaBindingPlan([{table:'question_payloads',contentBatchId:'4'.repeat(64),before:{id:'00000000-0000-4000-8000-000000000001',payload:{image:{url:source,width:0,height:0},answer:'same'}}}],{targetProject:prod,...verified,imageMetadata:{[source]:{sha256,bytes:bytes.length,width,height:7}}});
 const p={...packet(),plan:make(12),mediaPlans:[media],destinationReceipts:receipts,loadImageBytes:async()=>bytes};p.expectedSha256=p.plan.sha256;
 assert.equal(checkMediaBindingPacket(p).dryRun,true);await verifyImageDimensionCorrections(p);
 await assert.rejects(verifyImageDimensionCorrections({...p,loadImageBytes:async()=>Buffer.from('wrong bytes')}),/checksum/);
 const forged={...p,plan:make(13)};forged.expectedSha256=forged.plan.sha256;
 await assert.rejects(runMediaBindings(forged),/actual decoded pixels/);
 const missing={...p};delete missing.loadImageBytes;await assert.rejects(runMediaBindings(missing),/Archived image bytes/);
});
