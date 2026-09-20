const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Content-only alignment can recover from verified source archives and the
 * operator's atomic before-image journal. This does not certify a full database
 * backup, and cannot be used for user, wallet or gameplay-history replacement.
 */
export function hasVerifiedStagingContentRecovery(evidence,planSha256){
 if(evidence.fullStagingRestoreVerified===true)return true;
 const recovery=evidence.scopedContentRecovery;
 return recovery?.kind==='archived-content-and-atomic-before-images'
  &&recovery.targetProject==='nsdfiprfmhdqhbfxfwpv'
  &&recovery.planSha256===planSha256&&digest(planSha256)
  &&recovery.originalContentRestored===true&&recovery.retainingUndoVerified===true
  &&recovery.replacesGameplayHistory===false&&recovery.replacesAccountsOrBalances===false
  &&Array.isArray(recovery.archiveSha256)&&recovery.archiveSha256.length>0
  &&recovery.archiveSha256.every(digest)&&digest(recovery.restoreReportSha256)
  &&digest(recovery.undoReportSha256);
}
