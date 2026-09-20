import postgres from 'postgres';
import {contentHash} from './question-manifest.mjs';
import {checkQuestionImportTarget} from './question-import.mjs';
import {buildCoreStagingAlignmentPlan, coreAlignmentBaseline} from './core-staging-alignment-plan.mjs';
import {hasVerifiedStagingContentRecovery} from './staging-content-recovery.mjs';

const STAGING = 'nsdfiprfmhdqhbfxfwpv', PRODUCTION = 'lfbwhxvwubzeqkztghok';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a,b) => contentHash(a) === contentHash(b);
const sorted = rows => rows.sort((a,b) => a.id.localeCompare(b.id));
const withoutUpdated = value => Object.fromEntries(Object.entries(value).map(([table,rows]) => [table,rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'updated_at')))]));

export function validateCoreStagingAlignmentPlan(plan, expectedSha256, snapshots) {
  if (!digest(expectedSha256) || plan.sha256 !== expectedSha256) throw new Error('Pinned core alignment plan required');
  const rebuilt = buildCoreStagingAlignmentPlan(snapshots);
  if (!same(plan,rebuilt)) throw new Error('Core alignment differs from the reviewed source snapshots');
  return plan;
}

async function snapshot(tx,plan) {
  const result = {};
  for (const table of plan.tables) {
    const ids = table.rows.map(row => row.stagingId);
    result[table.table] = ids.length ? sorted((await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table.table} t WHERE id = ANY($1::uuid[])`,[ids])).map(row => row.row)) : [];
    if (result[table.table].length !== ids.length) throw new Error('An original catalogue row is missing');
  }
  return result;
}

async function applyFields(tx,plan,current,undo) {
  for (const table of plan.tables) {
    const originals = new Map(current[table.table].map(row => [row.id,row]));
    const groups = new Map();
    for (const row of table.rows) {
      const fields = Object.keys(row.after).sort(), key = fields.join(',');
      const values = {id:row.stagingId,...Object.fromEntries(fields.map(field => [field,undo ? originals.get(row.stagingId)[field] : row.after[field]]))};
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(values);
    }
    for (const [key,rows] of groups) {
      // Column names come exclusively from a rebuilt, fixed-field pure plan.
      const assignments = key.split(',').map(field => `"${field}"=s."${field}"`).join(',');
      const changed = await tx.unsafe(`UPDATE public.${table.table} t SET ${assignments} FROM jsonb_populate_recordset(NULL::public.${table.table},$1::jsonb) s WHERE t.id=s.id RETURNING t.id`,[rows]);
      if (changed.length !== rows.length) throw new Error('Catalogue update count changed');
    }
  }
}

/** Run before staging media bindings, using the pinned original source archives.
 * No IDs, publication flags, histories or production database rows are changed.
 * Undo restores only the reviewed fields and refuses any subsequent row edit.
 */
export async function runCoreStagingAlignment({databaseUrl,plan:input,expectedSha256,snapshots,action='dry-run',rehearsal=false,evidence={}}) {
  const plan = validateCoreStagingAlignmentPlan(input,expectedSha256,snapshots), url = new URL(databaseUrl);
  if (!['dry-run','apply','undo','undo-dry-run'].includes(action)) throw new Error('Unknown core alignment action');
  if (rehearsal && (url.hostname !== '127.0.0.1' || url.port !== '55519' || !/^\/rehearsal_[a-z0-9_]+$/.test(url.pathname))) throw new Error('Isolated rehearsal connection required');
  checkQuestionImportTarget(databaseUrl,STAGING,{allowLocal:rehearsal});
  if (!rehearsal && !['require','verify-full','verify-ca'].includes(url.searchParams.get('sslmode'))) throw new Error('Encrypted staging connection required');
  const dryRun = action.endsWith('dry-run'), undo = action.startsWith('undo');
  if (!dryRun && !rehearsal && (!hasVerifiedStagingContentRecovery(evidence,plan.sha256) || !evidence.runtimeDrained
    || !['backupSha256','reservationSha256','rehearsalSha256','historyAuditSha256','mediaArchiveSha256'].every(key=>digest(evidence[key]))
    || evidence.verifiedMediaUrlsSha256 !== contentHash(plan.mediaUrls))) throw new Error('Verified recovery, history, reservation and canonical media required');
  const sql = postgres(databaseUrl,{max:1,prepare:false,onnotice:()=>{}});
  try {return await sql.begin(dryRun ? 'ISOLATION LEVEL REPEATABLE READ READ ONLY' : '', async tx => {
    await tx`SET LOCAL timezone='UTC'`;
    await tx`SET LOCAL lock_timeout='2s'`;
    await tx`SET LOCAL statement_timeout='60s'`;
    if (!dryRun) {
      await tx`SELECT pg_advisory_xact_lock(20260920,74459)`;
      await tx`LOCK TABLE football_players,fifa_cards,goal_choreographies,player_clue_cards IN SHARE ROW EXCLUSIVE MODE`;
    }
    const current = await snapshot(tx,plan);
    const [batch] = await tx`SELECT * FROM core_staging_alignment_batches WHERE id=${plan.sha256}`;
    const report = {planSha256:plan.sha256,action,dryRun,changed:false,resumed:false,needsReview:false,rows:plan.tables.reduce((sum,t)=>sum+t.rows.length,0),idsChanged:0,deletedRows:0};
    if (batch && (batch.source_project !== PRODUCTION || batch.target_project !== STAGING || !batch.after_data)) throw new Error('Core alignment journal is incomplete or differs');
    if (undo) {
      if (!batch) throw new Error('No core alignment to undo');
      if (batch.undone_at) { if (!same(current,batch.undo_data)) throw new Error('Catalogue changed after undo'); return {...report,resumed:true}; }
      if (!same(current,batch.after_data)) return {...report,needsReview:true};
    } else if (batch) {
      if (batch.undone_at) throw new Error('Undone core alignment cannot be reapplied');
      if (!same(current,batch.after_data)) throw new Error('Catalogue changed after alignment');
      return {...report,resumed:true};
    } else {
      for (const table of plan.tables) {
        const rows = new Map(current[table.table].map(row=>[row.id,row]));
        for (const row of table.rows) if (!same(coreAlignmentBaseline(rows.get(row.stagingId)),row.baseline)) throw new Error('Catalogue changed since source review');
      }
    }
    if (dryRun) return report;
    if (!undo) await tx`INSERT INTO core_staging_alignment_batches(id,source_project,target_project,before_data,verification)
      VALUES(${plan.sha256},${PRODUCTION},${STAGING},${tx.json(current)},${tx.json({evidence,rehearsal,referencePackageSha256:plan.referencePackageSha256})})`;
    await applyFields(tx,plan,undo ? batch.before_data : current,undo);
    const after = await snapshot(tx,plan);
    const expected = Object.fromEntries(plan.tables.map(table => {
      const patches = new Map(table.rows.map(row=>[row.stagingId,row.after]));
      return [table.table,current[table.table].map(row=>({...row,...patches.get(row.id)}))];
    }));
    if (!same(withoutUpdated(after),withoutUpdated(undo ? batch.before_data : expected))) throw new Error('Catalogue alignment changed unexpected fields');
    if (undo) await tx`UPDATE core_staging_alignment_batches SET undo_data=${tx.json(after)},undone_at=now() WHERE id=${plan.sha256}`;
    else await tx`UPDATE core_staging_alignment_batches SET after_data=${tx.json(after)} WHERE id=${plan.sha256}`;
    return {...report,changed:true};
  });} finally {await sql.end({timeout:5});}
}
