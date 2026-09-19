import postgres from 'postgres';
import {contentHash} from './question-manifest.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
import {applyMediaBindings,validateMediaBindingPlan,verifiedMediaUrlMap} from './content-media-bindings.mjs';
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
 const dryRun=action.endsWith('dry-run');
 if(!dryRun&&!rehearsal&&(!evidence.fullRestoreVerified||!hash(evidence.backupSha256)||!hash(evidence.reservationSha256)||!hash(evidence.rehearsalSha256)))throw new Error('Verified recovery, rehearsal and content reservation evidence is required');
 return {dryRun,undo:action.startsWith('undo'),allowStagingOriginals,expectedSha256};
}
export async function runMediaBindings(packet){
 const options=checkMediaBindingPacket(packet);
 const sql=postgres(packet.databaseUrl,{max:1,prepare:false,onnotice:()=>{},connect_timeout:10,idle_timeout:5});
 try{return await applyMediaBindings(sql,packet.plan,options);}finally{await sql.end({timeout:5});}
}
