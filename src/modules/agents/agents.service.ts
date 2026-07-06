import { NotFoundError, BadRequestError } from '../../core/errors.js';
import { deleteQuestionImageByUrl } from '../questions/question-image-storage.service.js';
import {
  agentsRepo,
  type AgentJobRow,
  type AgentTaskRow,
  type AgentPromptRow,
  type AgentQuestionTypeRow,
  type AgentScheduleRow,
} from './agents.repo.js';
import type {
  AgentJob,
  AgentTask,
  SpawnJobBody,
  ActivePrompt,
  PromptVersion,
  PromptRole,
  QuestionType,
  AgentSchedule,
  AgentReviewItem,
} from './agents.schemas.js';

// A group of review items sharing a source + topic (e.g. "daily · Juventus").
interface ReviewGroup {
  source: string;
  topic: string | null;
  count: number;
  items: AgentReviewItem[];
}

// Which agent question type each daily-challenge type consumes (the inverse of
// getQuestionTypeForChallenge in daily-challenges.service.ts) + its display name.
// Used to tell the editor which live daily challenges a draft question can feed.
const CHALLENGE_BY_QUESTION_TYPE: Record<string, { challengeType: string; title: string }[]> = {
  mcq_single: [{ challengeType: 'moneyDrop', title: 'Money Drop' }],
  true_false: [{ challengeType: 'trueFalse', title: 'True or False' }],
  countdown_list: [{ challengeType: 'countdown', title: 'Countdown' }],
  clue_chain: [{ challengeType: 'clues', title: 'Clues' }],
  put_in_order: [{ challengeType: 'putInOrder', title: 'Put in Order' }],
  career_path: [{ challengeType: 'careerPath', title: 'Career Path' }],
  imposter_multi_select: [{ challengeType: 'imposter', title: "Pick'em" }],
  high_low: [{ challengeType: 'highLow', title: 'High Low' }],
};
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

function toSchedule(r: AgentScheduleRow): AgentSchedule {
  return {
    id: r.id,
    label: r.label,
    jobType: r.job_type,
    enabled: r.enabled,
    hourTbilisi: r.hour_tbilisi,
    params: r.params,
    lastRunAt: r.last_run_at,
    lastJobId: r.last_job_id,
    lastStatus: r.last_status,
  };
}

// Resolve a concrete category for a schedule run from its params. Supports:
//   - a fixed `categoryId` (+ optional `topic`)
//   - a `rotation` array of { categoryId, topic } — rotated by day-of-year so
//     consecutive days differ; run-now picks today's entry.
// Returns null if neither is configured (caller rejects the run).
function pickScheduleCategory(
  params: Record<string, unknown>
): { categoryId: string; topic?: string } | null {
  const fixed = (params.categoryId ?? params.category_id) as string | undefined;
  if (fixed) return { categoryId: fixed, topic: params.topic as string | undefined };

  const rotation = params.rotation as { categoryId: string; topic?: string }[] | undefined;
  if (Array.isArray(rotation) && rotation.length > 0) {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const dayOfYear = Math.floor((now.getTime() - start) / 86_400_000);
    const entry = rotation[dayOfYear % rotation.length];
    if (entry?.categoryId) return { categoryId: entry.categoryId, topic: entry.topic };
  }
  return null;
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

  // A difficultyMix ("25 hard / 20 medium / 5 easy") fans out into one job per
  // non-zero difficulty; a plain difficulty+count stays a single job. The first
  // job is returned (with spawnedJobs = total) so the existing UI keeps working.
  async spawn(body: SpawnJobBody, userId: string | null): Promise<AgentJob & { spawnedJobs: number }> {
    const splits = body.difficultyMix
      ? (['easy', 'medium', 'hard'] as const)
          .map((d) => ({ difficulty: d, count: body.difficultyMix?.[d] ?? 0 }))
          .filter((s) => s.count > 0)
      : [{ difficulty: body.difficulty, count: body.count ?? 25 }];

    let first: Awaited<ReturnType<typeof agentsRepo.createJob>> | null = null;
    for (const split of splits) {
      const params: Json = {
        type: body.type,
        questionType: body.questionType,
        category_id: body.categoryId,
        topic: body.topic,
        difficulty: split.difficulty,
        count: split.count,
      } as Json;
      const row = await agentsRepo.createJob({
        type: body.type,
        params,
        requestedBy: userId,
        budgetCents: body.budgetCents ?? null,
      });
      first ??= row;
    }
    return { ...toJob(first!), spawnedJobs: splits.length };
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

  // ── Live activity feed ──
  // Every running session + a rollup of the last hour, for the "what's happening
  // now" screen. durationSeconds is computed server-side off started_at.
  async activity(): Promise<{
    running: {
      id: string;
      role: string;
      model: string | null;
      jobId: string | null;
      taskSeq: number | null;
      topic: string | null;
      question: string | null;
      startedAt: string;
      durationSeconds: number;
    }[];
    recent: { generated: number; approved: number; rejected: number; failed: number; windowHours: number };
  }> {
    const windowHours = 1;
    const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const [sessions, recent] = await Promise.all([
      agentsRepo.liveSessions(),
      agentsRepo.recentActivity(sinceIso),
    ]);
    const now = Date.now();
    return {
      running: sessions.map((s) => ({
        id: s.id,
        role: s.role,
        model: s.model,
        jobId: s.job_id,
        taskSeq: s.task_seq,
        topic: s.job_topic,
        question: s.question,
        startedAt: s.started_at,
        durationSeconds: Math.max(0, Math.round((now - new Date(s.started_at).getTime()) / 1000)),
      })),
      recent: { ...recent, windowHours },
    };
  },

  // ── Stats rollups ──
  async stats(days = 7): Promise<{
    days: number;
    daily: { day: string; approved: number; rejected: number; costCents: number }[];
    rejections: { stage: string; count: number }[];
    timings: { role: string; avgSeconds: number; runs: number }[];
    totals: { approved: number; rejected: number; costCents: number; approvalRate: number };
  }> {
    const [daily, rejections, timings] = await Promise.all([
      agentsRepo.dailyStats(days),
      agentsRepo.rejectionReasons(days),
      agentsRepo.stageTimings(days),
    ]);
    const approved = daily.reduce((s, d) => s + d.approved, 0);
    const rejected = daily.reduce((s, d) => s + d.rejected, 0);
    const costCents = daily.reduce((s, d) => s + d.cost_cents, 0);
    const decided = approved + rejected;
    return {
      days,
      daily: daily.map((d) => ({ day: d.day, approved: d.approved, rejected: d.rejected, costCents: d.cost_cents })),
      rejections: rejections.map((r) => ({ stage: r.stage, count: r.count })),
      timings: timings.map((t) => ({ role: t.role, avgSeconds: t.avg_seconds, runs: t.runs })),
      totals: { approved, rejected, costCents, approvalRate: decided ? Math.round((approved / decided) * 100) : 0 },
    };
  },

  // ── Schedules ──
  async schedules(): Promise<{ items: AgentSchedule[] }> {
    const rows = await agentsRepo.listSchedules();
    return { items: rows.map(toSchedule) };
  },

  async updateSchedule(
    id: string,
    body: { enabled?: boolean; hourTbilisi?: number; params?: Record<string, unknown> }
  ): Promise<AgentSchedule> {
    const row = await agentsRepo.updateSchedule(id, {
      enabled: body.enabled,
      hourTbilisi: body.hourTbilisi,
      params: body.params as Json | undefined,
    });
    if (!row) throw new NotFoundError(`Schedule ${id} not found`);
    return toSchedule(row);
  },

  // Recent runs (jobs) produced by a schedule — its history strip.
  async scheduleRuns(id: string): Promise<{ items: AgentJob[] }> {
    const sched = await agentsRepo.getSchedule(id);
    if (!sched) throw new NotFoundError(`Schedule ${id} not found`);
    const rows = await agentsRepo.scheduleRuns(sched.job_type);
    return { items: rows.map(toJob) };
  },

  // Run a schedule immediately: expand its params template into a one-off job now.
  // (The recurring cron still fires on its own; this is a manual "run now".)
  // A category must be resolvable (fixed categoryId or a rotation entry) — else
  // the job would generate questions that can't be published (category_id NOT NULL).
  async runScheduleNow(id: string, userId: string | null): Promise<AgentJob> {
    const sched = await agentsRepo.getSchedule(id);
    if (!sched) throw new NotFoundError(`Schedule ${id} not found`);
    const p = (sched.params ?? {}) as Record<string, unknown>;
    const picked = pickScheduleCategory(p);
    if (!picked) {
      throw new BadRequestError(
        'This schedule has no category configured. Add a categoryId or a rotation (categoryIds) in its params first.'
      );
    }
    const row = await agentsRepo.createJob({
      type: sched.job_type,
      params: {
        ...p,
        category_id: picked.categoryId,
        topic: picked.topic ?? (p.topic as string | undefined) ?? 'daily challenge — football history',
        manual: true,
      } as Json,
      requestedBy: userId,
      budgetCents: null,
    });
    return toJob(row);
  },

  // ── Review queue: the editor's inbox of agent-generated draft questions ──
  async reviewQueue(): Promise<{ count: number; groups: ReviewGroup[] }> {
    const [rows, activeChallenges] = await Promise.all([
      agentsRepo.reviewQueue(),
      agentsRepo.activeDailyChallenges(),
    ]);
    // For a question (type + category), which ACTIVE daily challenges can use it?
    // A challenge qualifies when its consumed question type matches AND its
    // category filter includes the category (empty filter = all categories).
    const feedsFor = (qType: string, categoryId: string): string[] => {
      const candidates = CHALLENGE_BY_QUESTION_TYPE[qType] ?? [];
      return candidates
        .filter((c) =>
          activeChallenges.some(
            (ac) =>
              ac.challenge_type === c.challengeType &&
              (ac.category_ids.length === 0 || ac.category_ids.includes(categoryId))
          )
        )
        .map((c) => c.title);
    };
    const items: AgentReviewItem[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      difficulty: r.difficulty,
      categoryId: r.category_id,
      prompt: r.prompt,
      payload: r.payload,
      verdicts: r.verdicts,
      warnings: r.warnings,
      source: r.job_type === 'daily_challenge' ? 'daily' : 'ranked',
      jobType: r.job_type,
      topic: r.topic,
      feedsChallenges: feedsFor(r.type, r.category_id),
      createdAt: r.created_at,
    }));
    // group by source then topic, so the editor sees "Daily · Juventus (3)" etc.
    const byKey = new Map<string, ReviewGroup>();
    for (const it of items) {
      const key = `${it.source}::${it.topic ?? ''}`;
      let g = byKey.get(key);
      if (!g) {
        g = { source: it.source, topic: it.topic, count: 0, items: [] };
        byKey.set(key, g);
      }
      g.items.push(it);
      g.count++;
    }
    return { count: items.length, groups: [...byKey.values()] };
  },

  async reviewCount(): Promise<{ count: number }> {
    return { count: await agentsRepo.reviewQueueCount() };
  },

  async approveQuestion(questionId: string): Promise<void> {
    const ok = await agentsRepo.setQuestionStatus(questionId, 'published');
    if (!ok) throw new NotFoundError('Draft agent question not found (already reviewed?)');
  },

  async rejectQuestion(questionId: string): Promise<void> {
    const imageUrl = await agentsRepo.questionImageUrl(questionId);
    const ok = await agentsRepo.setQuestionStatus(questionId, 'archived');
    if (!ok) throw new NotFoundError('Draft agent question not found (already reviewed?)');
    await deleteQuestionImageByUrl(imageUrl); // rejected drafts don't keep their photo in the bucket
  },

  // Editor fix-ups (wrong translation, typo, awkward phrasing) applied in place
  // from the review queue — no reject/regenerate cycle needed.
  async updateReviewQuestion(
    questionId: string,
    body: { prompt?: { en: string; ka: string }; payload?: Record<string, unknown> }
  ): Promise<void> {
    const ok = await agentsRepo.updateQuestionContent(
      questionId,
      body.prompt as Json | undefined,
      body.payload as Json | undefined
    );
    if (!ok) throw new NotFoundError('Draft agent question not found (already reviewed?)');
  },

  // Manual "Regenerate": archive this draft and spawn a fresh 1-question job of
  // the same type + category + topic. The new question flows through the pipeline
  // and lands back in the review queue.
  async regenerateQuestion(questionId: string, userId: string | null): Promise<AgentJob> {
    const ctx = await agentsRepo.questionRegenContext(questionId);
    if (!ctx) throw new NotFoundError('Draft agent question not found (already reviewed?)');
    const imageUrl = await agentsRepo.questionImageUrl(questionId);
    await agentsRepo.setQuestionStatus(questionId, 'archived');
    await deleteQuestionImageByUrl(imageUrl); // the replacement job sources a fresh photo
    const row = await agentsRepo.createJob({
      type: ctx.job_type,
      params: {
        type: ctx.job_type,
        questionType: ctx.type,
        category_id: ctx.category_id,
        topic: ctx.topic ?? 'football history',
        difficulty: 'medium',
        count: 1,
        regenerated_from: questionId,
      } as Json,
      requestedBy: userId,
      budgetCents: null,
    });
    return toJob(row);
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
    pauseReason: string | null;
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
      // why we're paused (latest auto_pause event, e.g. subscription limit) —
      // only meaningful while paused
      pauseReason: b?.paused ? await agentsRepo.latestAutoPauseReason() : null,
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
