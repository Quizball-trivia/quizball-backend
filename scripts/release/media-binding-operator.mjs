import postgres from 'postgres';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {contentHash} from './question-manifest.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
import {applyMediaBindings,validateMediaBindingPlan,verifiedMediaUrlMap} from './content-media-bindings.mjs';
import {hasVerifiedStagingContentRecovery} from './staging-content-recovery.mjs';
const STAGE='nsdfiprfmhdqhbfxfwpv';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Validate the complete operator packet before opening a database connection.
 * Asset plans and byte receipts must reconstruct exactly the reviewed URL map.
 * Recovery/reservation hashes reference retained evidence, not user prompts.
 */
export function checkMediaBindingPacket({databaseUrl,plan,expectedSha256,mediaPlans,destinationReceipts,action='dry-run',rehearsal=false,allowStagingOriginals=false,evidence={}}){
 if(!['dry-run','apply','undo-dry-run','undo'].includes(action))throw new Error('Unknown media binding action');
 validateMediaBindingPlan(plan,expectedSha256);
 const url=new URL(databaseUrl);
 if(rehearsal&&(url.hostname!=='127.0.0.1'||url.port!=='55519'||!/^\/rehearsal_[a-z0-9_]+$/.test(url.pathname)))throw new Error('Isolated media rehearsal connection required');
 checkQuestionImportTarget(databaseUrl,plan.targetProject,{allowLocal:rehearsal});
 if(!rehearsal&&url.searchParams.get('sslmode')!=='require'&&url.searchParams.get('sslmode')!=='verify-full')throw new Error('Encrypted cloud database connection required');
 if(allowStagingOriginals&&plan.targetProject!==STAGE)throw new Error('Existing production content cannot be rebound');
 const verified=verifiedMediaUrlMap(mediaPlans,destinationReceipts);
 if(verified.verificationSha256!==plan.verificationSha256||contentHash(verified.mapping)!==contentHash(plan.mapping))throw new Error('Media binding differs from the complete verified asset map');
 const objects=new Map(mediaPlans.flatMap(p=>p.objects.map(r=>[r.publicUrl,r])));
 for(const [source,metadata] of Object.entries(plan.imageMetadata??{})){
  const object=objects.get(plan.mapping[source]);
  if(!object?.contentType.startsWith('image/')||object.sha256!==metadata.sha256||object.bytes!==metadata.bytes)throw new Error('Image metadata differs from the verified destination bytes');
 }
 const dryRun=action.endsWith('dry-run');
 const recoveryVerified=plan.targetProject===STAGE
  ? evidence.fullRestoreVerified===true||hasVerifiedStagingContentRecovery(evidence,plan.sha256)
  : evidence.fullRestoreVerified===true;
 if(!dryRun&&!rehearsal&&(!recoveryVerified||!hash(evidence.backupSha256)||!hash(evidence.reservationSha256)||!hash(evidence.rehearsalSha256)))throw new Error('Verified recovery, rehearsal and content reservation evidence is required');
 return {dryRun,undo:action.startsWith('undo'),allowStagingOriginals,expectedSha256};
}
export async function verifyImageDimensionCorrections(packet){
 // Decode independently before opening any database connection. The caller's
 // loader can read an archive, but cannot substitute different image bytes.
 for(const [source,metadata] of Object.entries(packet.plan.imageMetadata??{})){
  if(typeof packet.loadImageBytes!=='function')throw new Error('Archived image bytes are required for dimension corrections');
  const bytes=await packet.loadImageBytes(source);
  if(!Buffer.isBuffer(bytes)||bytes.length!==metadata.bytes||createHash('sha256').update(bytes).digest('hex')!==metadata.sha256)throw new Error('Archived correction image checksum differs');
  const decoded=sharp(bytes,{limitInputPixels:50_000_000}),actual=await decoded.metadata();await decoded.stats();
  if(actual.width!==metadata.width||actual.height!==metadata.height)throw new Error('Planned image dimensions differ from actual decoded pixels');
 }
}
export async function runMediaBindings(packet){
 const options=checkMediaBindingPacket(packet);
 await verifyImageDimensionCorrections(packet);
 const sql=postgres(packet.databaseUrl,{max:1,prepare:false,onnotice:()=>{},connect_timeout:10,idle_timeout:5});
 try{return await applyMediaBindings(sql,packet.plan,options);}finally{await sql.end({timeout:5});}
}
