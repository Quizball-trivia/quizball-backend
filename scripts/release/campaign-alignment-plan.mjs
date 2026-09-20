import {contentHash} from './question-manifest.mjs';
const LOCAL_FIELDS=new Set(['created_at','updated_at','created_by','updated_by','preview_token']);
const RELATIONS={campaign_quiz_questions:['quiz_slug','question_id','difficulty','display_order'],campaign_quiz_manual_questions:['quiz_slug','question_id'],campaign_quiz_related_pages:['quiz_slug','related_slug','display_order']};
const key=(table,row)=>table==='campaign_quiz_questions'||table==='campaign_quiz_manual_questions'?row.quiz_slug+':'+row.question_id:row.quiz_slug+':'+row.related_slug;
const sorted=(table,rows)=>rows.map(r=>Object.fromEntries(RELATIONS[table].map(k=>[k,r[k]]))).sort((a,b)=>key(table,a).localeCompare(key(table,b)));
const editorial=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!LOCAL_FIELDS.has(k)).sort(([a],[b])=>a.localeCompare(b)));
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
/** Pure plan only. Capture live before/after rows in a private durable journal
 * when executing. Never change users, ratings, revisions or question content.
 * Production publication and curation win; staging secrets/authorship stay local.
 */
export function buildCampaignAlignmentPlan(staging,production,{stagingSnapshotSha256,productionSnapshotSha256,questionStatePlanSha256}={}){
 if(![stagingSnapshotSha256,productionSnapshotSha256,questionStatePlanSha256].every(hash))throw new Error('Pinned campaign and question-state snapshots required');
 for(const data of [staging,production])for(const table of ['campaign_quizzes',...Object.keys(RELATIONS),'campaign_quiz_routes','campaign_quiz_revisions'])if(!Array.isArray(data[table]))throw new Error('Complete campaign snapshots required');
 if(staging.campaign_quiz_routes.length||production.campaign_quiz_routes.length)throw new Error('Campaign redirects require separate review');
 const slugs=data=>data.campaign_quizzes.map(r=>r.slug).sort();
 const sourceSlugs=slugs(staging),targetSlugs=slugs(production);
 if(!sourceSlugs.length||new Set(sourceSlugs).size!==sourceSlugs.length||new Set(targetSlugs).size!==targetSlugs.length||contentHash(sourceSlugs)!==contentHash(targetSlugs))throw new Error('Campaign creation/removal requires separate review');
 const allowed=new Set(sourceSlugs),tables={};
 for(const [table,fields] of Object.entries(RELATIONS)){
  for(const data of [staging,production]){
   const ids=new Set();
   for(const row of data[table]){if(!allowed.has(row.quiz_slug)||('related_slug' in row&&!allowed.has(row.related_slug))||fields.some(f=>row[f]===undefined)||ids.has(key(table,row)))throw new Error('Invalid campaign relation identity');ids.add(key(table,row));}
  }
  tables[table]={before:sorted(table,staging[table]),after:sorted(table,production[table])};
 }
 const prodBySlug=new Map(production.campaign_quizzes.map(r=>[r.slug,r]));
 const pages=staging.campaign_quizzes.map(row=>{const before=editorial(row),after=editorial(prodBySlug.get(row.slug));if(Object.keys(before).join(',')!==Object.keys(after).join(','))throw new Error('Campaign schema columns differ');return {slug:row.slug,before,after};}).sort((a,b)=>a.slug.localeCompare(b.slug));
 const body={format:1,executable:false,sourceProject:'lfbwhxvwubzeqkztghok',targetProject:'nsdfiprfmhdqhbfxfwpv',operation:'production-canonical-campaign-alignment',
  stagingSnapshotSha256,productionSnapshotSha256,questionStatePlanSha256,slugs:sourceSlugs,pages,tables,
  preservedLocalFields:[...LOCAL_FIELDS].sort(),preservedTables:['campaign_quiz_ratings','campaign_quiz_revisions','campaign_quiz_routes','questions','question_payloads'],
  stagingRevisionCount:staging.campaign_quiz_revisions.length,
  gates:['Complete backup/restore and staging reservation.','Verify canonical questions are present, public, published where required, and excluded from ranked.','Preserve full original page/relation rows in a private durable journal before any replacement.','Keep preview tokens, author IDs, ratings and revision history local.','Require no-op campaign reservation triggers for already reserved questions.','Apply atomically with later-editor detection and retaining undo; then exercise published SEO pages.']};
 return {...body,sha256:contentHash(body)};
}
