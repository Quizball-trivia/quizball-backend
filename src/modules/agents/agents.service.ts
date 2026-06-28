import { NotFoundError } from '../../core/errors.js';
import {
  agentsRepo,
  type AgentJobRow,
  type AgentTaskRow,
  type AgentPromptRow,
  type AgentQuestionTypeRow,
} from './agents.repo.js';
import type {
  AgentJob,
  AgentTask,
  SpawnJobBody,
  ActivePrompt,
  PromptVersion,
  PromptRole,
  QuestionType,
} from './agents.schemas.js';
import type { Json } from '../../db/types.js';

// Monthly Agent-SDK credit ceiling (Max-20x agent credit), in cents.
// Configurable via AGENT_MONTHLY_CREDIT_CENTS; defaults to 20000 ($200).
const MONTHLY_CREDIT_CENTS = Number.parseInt(process.env.AGENT_MONTHLY_CREDIT_CENTS ?? '', 10) || 20000;

export interface AgentRosterEntry {
  role: string;
  label: string;
  description: string;
  model: string;
  promptVersion: number | null;
  promptPreview: string | null;
  runsToday: number;
  succeededToday: number;
  failedToday: number;
  runningNow: number;
  avgCostCents: number;
  lastRunAt: string | null;
}

function toActivePrompt(r: AgentPromptRow): ActivePrompt {
  return {
    role: r.role,
    type: r.type,
    content: r.content,
    version: r.version,
    note: r.note,
    updatedAt: r.created_at,
  };
}

function toQuestionType(r: AgentQuestionTypeRow): QuestionType {
  return {
    type: r.type,
    label: r.label,
    description: r.description,
    enabled: r.enabled,
    sortOrder: r.sort_order,
  };
}

function toPromptVersion(r: AgentPromptRow): PromptVersion {
  return {
    id: r.id,
    version: r.version,
    content: r.content,
    note: r.note,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

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
      questionType: body.questionType,
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

  // The sub-agent roster: one entry per role with description, model, current
  // prompt (truncated), and live stats from sessions. Drives the "Sub-agents" page.
  async roster(): Promise<{ items: AgentRosterEntry[] }> {
    const ROLES: { role: PromptRole; label: string; description: string; defaultModel: string }[] = [
      { role: 'generator', label: 'Question Generator', description: 'Writes new bilingual MCQ questions for a category in the Quizball style.', defaultModel: 'claude-sonnet-4-6' },
      { role: 'factcheck', label: 'Fact Checker', description: 'Web-grounded; verifies the answer is correct and every option is factually accurate. The hard gate.', defaultModel: 'claude-sonnet-4-6' },
      { role: 'criteria', label: 'Criteria / Style Checker', description: 'Checks each question against the style criteria (context-complete, not dry, good distractors). Advisory.', defaultModel: 'claude-sonnet-4-6' },
      { role: 'dedupe', label: 'Dedupe Checker', description: 'Decides whether a generated question is genuinely new vs. already in the bank.', defaultModel: 'claude-haiku-4-5' },
    ];
    const [stats, prompts] = await Promise.all([agentsRepo.agentStats(), agentsRepo.listActivePrompts()]);
    const statByRole = new Map(stats.map((s) => [s.role, s]));
    const promptByRole = new Map(prompts.map((p) => [p.role, p]));
    const items = ROLES.map((r) => {
      const s = statByRole.get(r.role);
      const p = promptByRole.get(r.role);
      return {
        role: r.role,
        label: r.label,
        description: r.description,
        model: s?.last_model ?? r.defaultModel,
        promptVersion: p?.version ?? null,
        promptPreview: p ? p.content.slice(0, 240) : null,
        runsToday: s?.runs_today ?? 0,
        succeededToday: s?.succeeded_today ?? 0,
        failedToday: s?.failed_today ?? 0,
        runningNow: s?.running_now ?? 0,
        avgCostCents: s?.avg_cost_cents ?? 0,
        lastRunAt: s?.last_run_at ?? null,
      };
    });
    return { items };
  },

  async budget(): Promise<{
    limitCents: number;
    spentTodayCents: number;
    spentWeekCents: number;
    spentMonthCents: number;
    monthlyCreditCents: number;
    paused: boolean;
  }> {
    const now = new Date();
    const weekSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [b, spentToday, spentWeek, spentMonth] = await Promise.all([
      agentsRepo.getBudget(),
      agentsRepo.spentTodayCents(),
      agentsRepo.spentSinceCents(weekSince),
      agentsRepo.spentSinceCents(monthSince),
    ]);
    return {
      limitCents: b?.limit_cents ?? 0,
      spentTodayCents: spentToday,
      spentWeekCents: spentWeek,
      spentMonthCents: spentMonth,
      monthlyCreditCents: MONTHLY_CREDIT_CENTS,
      paused: b?.paused ?? false,
    };
  },

  async setBudget(limitCents?: number, paused?: boolean): Promise<void> {
    await agentsRepo.setBudget({ limitCents, paused });
  },

  async retryTask(taskId: string, userId: string | null): Promise<void> {
    await agentsRepo.retryTask(taskId, userId);
  },

  // ── Editable sub-agent prompts ──

  async listPrompts(type?: string): Promise<{ items: ActivePrompt[] }> {
    const rows = await agentsRepo.listActivePrompts(type);
    return { items: rows.map(toActivePrompt) };
  },

  async promptHistory(role: PromptRole, type?: string): Promise<{ items: PromptVersion[] }> {
    const rows = await agentsRepo.getPromptHistory(role, type ?? '*');
    return { items: rows.map(toPromptVersion) };
  },

  async savePrompt(
    role: PromptRole,
    content: string,
    note: string | null,
    userId: string | null,
    type?: string
  ): Promise<ActivePrompt> {
    const row = await agentsRepo.savePrompt(role, type ?? '*', content, note, userId);
    return toActivePrompt(row);
  },

  async activatePrompt(promptId: string): Promise<ActivePrompt> {
    const row = await agentsRepo.activatePromptVersion(promptId);
    if (!row) throw new NotFoundError('Prompt version not found');
    return toActivePrompt(row);
  },

  // ── Question types ──

  async listQuestionTypes(): Promise<{ items: QuestionType[] }> {
    const rows = await agentsRepo.listQuestionTypes();
    return { items: rows.map(toQuestionType) };
  },

  async updateQuestionType(
    type: string,
    params: { enabled?: boolean; description?: string }
  ): Promise<QuestionType> {
    const row = await agentsRepo.updateQuestionType(type, params);
    if (!row) throw new NotFoundError('Question type not found');
    return toQuestionType(row);
  },
};
