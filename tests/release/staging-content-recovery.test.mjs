import test from 'node:test';import assert from 'node:assert/strict';
import {hasVerifiedStagingContentRecovery} from '../../scripts/release/staging-content-recovery.mjs';
const sha='a'.repeat(64);
const packet=()=>({fullStagingRestoreVerified:false,scopedContentRecovery:{kind:'archived-content-and-atomic-before-images',targetProject:'nsdfiprfmhdqhbfxfwpv',planSha256:sha,originalContentRestored:true,retainingUndoVerified:true,replacesGameplayHistory:false,replacesAccountsOrBalances:false,archiveSha256:['b'.repeat(64)],restoreReportSha256:'c'.repeat(64),undoReportSha256:'d'.repeat(64)}});
test('verified scoped content recovery is explicit and bound to one staging plan',()=>{
 assert.equal(hasVerifiedStagingContentRecovery(packet(),sha),true);
 assert.equal(hasVerifiedStagingContentRecovery(packet(),'e'.repeat(64)),false);
 assert.equal(hasVerifiedStagingContentRecovery({},sha),false);
 assert.equal(hasVerifiedStagingContentRecovery({fullStagingRestoreVerified:true},sha),true);
});
test('incomplete archives, untested undo, other environments and history replacement are refused',()=>{
 for(const [key,value]of [['targetProject','lfbwhxvwubzeqkztghok'],['archiveSha256',[]],['originalContentRestored',false],['retainingUndoVerified',false],['replacesGameplayHistory',true],['replacesAccountsOrBalances',true],['restoreReportSha256',null]]){
  const p=packet();p.scopedContentRecovery[key]=value;assert.equal(hasVerifiedStagingContentRecovery(p,sha),false,key);
 }
});
