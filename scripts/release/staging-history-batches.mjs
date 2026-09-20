import postgres from 'postgres';
import { validateAlignmentInput, runStagingQuestionAlignment } from './staging-question-alignment.mjs';
import { checkQuestionImportTarget } from './question-import.mjs';
import { hasVerifiedStagingContentRecovery } from './staging-content-recovery.mjs';

// Append the same immutable reader snapshot as canonical alignment, but only
// for ended matches, in small transactions. Never change existing snapshots.
export async function appendHistoryBatch(sql, keys) {
  if (!keys.length || keys.length > 250) throw new Error('Expected 1–250 historical keys');
  try { return await sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout='1s'`;
    await tx`SET LOCAL statement_timeout='5s'`;
    await tx`SELECT pg_advisory_xact_lock(20260919,33342)`;
    const [result] = await tx`WITH selected AS MATERIALIZED (
      SELECT mq.match_id,mq.q_index,q.prompt,q.difficulty,p.payload,c.name,c.icon
      FROM jsonb_to_recordset(${tx.json(keys)}) AS k(match_id uuid,q_index integer)
      JOIN public.match_questions mq USING(match_id,q_index)
      JOIN public.matches m ON m.id=mq.match_id
      JOIN public.questions q ON q.id=mq.question_id
      JOIN public.question_payloads p ON p.question_id=q.id
      JOIN public.categories c ON c.id=mq.category_id
      WHERE mq.content_snapshot IS NULL AND m.status <> 'active'
      FOR UPDATE OF mq SKIP LOCKED
    ), updated AS (
      UPDATE public.match_questions mq SET content_snapshot=jsonb_build_object(
        'prompt',s.prompt,'difficulty',s.difficulty,'payload',s.payload,'category_name',s.name,'category_icon',s.icon)
      FROM selected s WHERE mq.match_id=s.match_id AND mq.q_index=s.q_index AND mq.content_snapshot IS NULL
      RETURNING 1
    ) SELECT count(*)::int n FROM updated`;
    return result.n;
  }); } catch (error) {
    if (error.code !== '57014' || !error.message.includes('statement timeout') || keys.length <= 50) throw error;
    // The timed-out transaction has rolled back. Retry disjoint smaller
    // groups, keeping the five-second limit and stopping if a small group fails.
    const middle = Math.ceil(keys.length / 2);
    const first = await appendHistoryBatch(sql, keys.slice(0, middle));
    return first + await appendHistoryBatch(sql, keys.slice(middle));
  }
}

export async function prepareStagingHistory({databaseUrl,plan,expectedPlanSha256,evidence,onProgress=()=>{}}) {
  validateAlignmentInput(plan,expectedPlanSha256);
  checkQuestionImportTarget(databaseUrl,'nsdfiprfmhdqhbfxfwpv');
  if (!hasVerifiedStagingContentRecovery(evidence,plan.sha256) || !evidence.historyAuditComplete)
    throw new Error('Verified staging content recovery and history audit required');
  onProgress({phase:'preflight'});
  const preflight=await runStagingQuestionAlignment({databaseUrl,plan,expectedPlanSha256,action:'dry-run'});
  if (preflight.alreadyApplied || preflight.needsReview.length) throw new Error('History preparation requires unmodified staging originals');
  const sql=postgres(databaseUrl,{max:1,prepare:false,onnotice:()=>{}});
  try {
    // Load PostgreSQL type metadata before constructing a UUID-array parameter.
    await sql`SELECT 1`;
    onProgress({phase:'select-remaining-history'});
    const keys=await sql`SELECT mq.match_id,mq.q_index FROM public.match_questions mq
      JOIN public.matches m ON m.id=mq.match_id WHERE mq.question_id=ANY(${sql.array(plan.updates.map(r=>r.id))}::uuid[])
      AND mq.content_snapshot IS NULL AND m.status <> 'active' ORDER BY mq.match_id,mq.q_index`;
    onProgress({phase:'append-history',planned:keys.length});
    const report={planSha256:plan.sha256,planned:keys.length,appended:0,batches:0,maxBatchMs:0,deleted:0,existingSnapshotsOverwritten:0};
    for(let offset=0;offset<keys.length;offset+=250) {
      const started=Date.now();
      report.appended+=await appendHistoryBatch(sql,keys.slice(offset,offset+250));
      report.maxBatchMs=Math.max(report.maxBatchMs,Date.now()-started); report.batches++;
      if(report.batches%20===0) onProgress({...report});
    }
    // Concurrently locked or newly completed history is left for a safe retry.
    const [remaining]=await sql`SELECT count(*)::int n FROM public.match_questions mq
      JOIN public.matches m ON m.id=mq.match_id WHERE mq.question_id=ANY(${sql.array(plan.updates.map(r=>r.id))}::uuid[])
      AND mq.content_snapshot IS NULL AND m.status <> 'active'`;
    return {...report,remaining:remaining.n,complete:remaining.n===0};
  } finally {await sql.end({timeout:5});}
}
