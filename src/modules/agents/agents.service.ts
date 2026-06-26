import { NotFoundError } from '../../core/errors.js';
import { agentsRepo, type AgentJobRow, type AgentTaskRow } from './agents.repo.js';
import type { AgentJob, AgentTask, SpawnJobBody } from './agents.schemas.js';
import type { Json } from '../../db/types.js';

function toJob(r: AgentJobRow): AgentJob {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    params: r.params,
    counts: r.counts,
    requestedBy: r.requested_by,
    budgetCents: r.budget_cents,
    spentCents: r.spent_cents,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toTask(r: AgentTaskRow): AgentTask {
  return {
    id: r.id,
    jobId: r.job_id,
    seq: r.seq,
    status: r.status,
    stage: r.stage,
    questionDraft: r.question_draft,
    verdicts: r.verdicts,
    warnings: r.warnings,
    decision: r.decision,
    rejectReason: r.reject_reason,
    publishedQuestionId: r.published_question_id,
    attempt: r.attempt,
    error: r.error,
  };
}

export const agentsService = {
  async listJobs(limit: number, offset: number): Promise<{ items: AgentJob[] }> {
    const rows = await agentsRepo.listJobs(limit, offset);
    return { items: rows.map(toJob) };
  },

  async getJob(id: string): Promise<AgentJob> {
    const row = await agentsRepo.getJob(id);
    if (!row) throw new NotFoundError('Job not found');
    return toJob(row);
  },

  async spawn(body: SpawnJobBody, userId: string | null): Promise<AgentJob> {
    const params: Json = {
      type: body.type,
      category_id: body.categoryId,
      topic: body.topic,
      difficulty: body.difficulty,
      count: body.count,
    } as Json;
    const row = await agentsRepo.createJob({
      type: body.type,
      params,
      requestedBy: userId,
      budgetCents: body.budgetCents ?? null,
    });
    return toJob(row);
  },

  async cancel(id: string): Promise<void> {
    await agentsRepo.cancelJob(id);
  },

  async tasks(jobId: string): Promise<{ items: AgentTask[] }> {
    const rows = await agentsRepo.listTasks(jobId);
    return { items: rows.map(toTask) };
  },

  async events(jobId: string): Promise<{ items: unknown[] }> {
    const rows = await agentsRepo.listEvents(jobId);
    return {
      items: rows.map((e) => ({
        id: e.id,
        taskId: e.task_id,
        ts: e.ts,
        level: e.level,
        type: e.type,
        message: e.message,
      })),
    };
  },

  async monitor(): Promise<{ running: { role: string; count: number }[]; total: number }> {
    const running = await agentsRepo.runningAgents();
    return { running, total: running.reduce((s, r) => s + r.count, 0) };
  },

  async budget(): Promise<{ limitCents: number; spentTodayCents: number; paused: boolean }> {
    const b = await agentsRepo.getBudget();
    const spent = await agentsRepo.spentTodayCents();
    return { limitCents: b?.limit_cents ?? 0, spentTodayCents: spent, paused: b?.paused ?? false };
  },

  async setBudget(limitCents?: number, paused?: boolean): Promise<void> {
    await agentsRepo.setBudget({ limitCents, paused });
  },

  async retryTask(taskId: string, userId: string | null): Promise<void> {
    await agentsRepo.retryTask(taskId, userId);
  },
};
