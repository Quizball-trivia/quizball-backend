import type { Request, Response } from 'express';
import { agentsService } from './agents.service.js';
import type {
  JobIdParam,
  ListJobsQuery,
  SetBudgetBody,
  SpawnJobBody,
  TaskIdParam,
  PromptRoleParam,
  PromptIdParam,
  PromptTypeQuery,
  SavePromptBody,
  QuestionTypeParam,
  UpdateQuestionTypeBody,
  ScheduleIdParam,
  UpdateScheduleBody,
  ReviewQuestionIdParam,
  UpdateReviewQuestionBody,
} from './agents.schemas.js';

// Admin controller for the CMS Agents section. Thin HTTP ↔ service layer.
export const agentsController = {
  async listJobs(req: Request, res: Response): Promise<void> {
    const { limit, offset } = req.validated.query as ListJobsQuery;
    res.json(await agentsService.listJobs(limit, offset));
  },

  async getJob(req: Request, res: Response): Promise<void> {
    const { jobId } = req.validated.params as JobIdParam;
    res.json(await agentsService.getJob(jobId));
  },

  async spawn(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as SpawnJobBody;
    const job = await agentsService.spawn(body, req.user?.id ?? null);
    res.status(201).json(job);
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const { jobId } = req.validated.params as JobIdParam;
    await agentsService.cancel(jobId);
    res.status(204).send();
  },

  async tasks(req: Request, res: Response): Promise<void> {
    const { jobId } = req.validated.params as JobIdParam;
    res.json(await agentsService.tasks(jobId));
  },

  async events(req: Request, res: Response): Promise<void> {
    const { jobId } = req.validated.params as JobIdParam;
    res.json(await agentsService.events(jobId));
  },

  async monitor(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.monitor());
  },

  async activity(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.activity());
  },

  async stats(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.stats());
  },

  // ── Schedules ──

  async listSchedules(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.schedules());
  },

  async updateSchedule(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as ScheduleIdParam;
    const body = req.validated.body as UpdateScheduleBody;
    res.json(await agentsService.updateSchedule(id, body));
  },

  async scheduleRuns(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as ScheduleIdParam;
    res.json(await agentsService.scheduleRuns(id));
  },

  async runScheduleNow(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as ScheduleIdParam;
    const job = await agentsService.runScheduleNow(id, req.user?.id ?? null);
    res.status(201).json(job);
  },

  // ── Review queue ──

  async reviewQueue(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.reviewQueue());
  },

  async reviewCount(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.reviewCount());
  },

  async approveQuestion(req: Request, res: Response): Promise<void> {
    const { questionId } = req.validated.params as ReviewQuestionIdParam;
    await agentsService.approveQuestion(questionId);
    res.status(204).send();
  },

  async rejectQuestion(req: Request, res: Response): Promise<void> {
    const { questionId } = req.validated.params as ReviewQuestionIdParam;
    await agentsService.rejectQuestion(questionId);
    res.status(204).send();
  },

  async regenerateQuestion(req: Request, res: Response): Promise<void> {
    const { questionId } = req.validated.params as ReviewQuestionIdParam;
    const job = await agentsService.regenerateQuestion(questionId, req.user?.id ?? null);
    res.status(201).json(job);
  },

  async updateReviewQuestion(req: Request, res: Response): Promise<void> {
    const { questionId } = req.validated.params as ReviewQuestionIdParam;
    const body = req.validated.body as UpdateReviewQuestionBody;
    await agentsService.updateReviewQuestion(questionId, body);
    res.status(204).send();
  },

  async budget(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.budget());
  },

  async setBudget(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as SetBudgetBody;
    await agentsService.setBudget(body.limitCents, body.paused);
    res.json(await agentsService.budget());
  },

  async retryTask(req: Request, res: Response): Promise<void> {
    const { taskId } = req.validated.params as TaskIdParam;
    await agentsService.retryTask(taskId, req.user?.id ?? null);
    res.status(202).send();
  },

  async roster(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.roster());
  },

  async listPrompts(req: Request, res: Response): Promise<void> {
    const { type } = req.validated.query as PromptTypeQuery;
    res.json(await agentsService.listPrompts(type));
  },

  async promptHistory(req: Request, res: Response): Promise<void> {
    const { role } = req.validated.params as PromptRoleParam;
    const { type } = req.validated.query as PromptTypeQuery;
    res.json(await agentsService.promptHistory(role, type));
  },

  async savePrompt(req: Request, res: Response): Promise<void> {
    const { role } = req.validated.params as PromptRoleParam;
    const body = req.validated.body as SavePromptBody;
    const prompt = await agentsService.savePrompt(
      role,
      body.content,
      body.note ?? null,
      req.user?.id ?? null,
      body.type
    );
    res.json(prompt);
  },

  async activatePrompt(req: Request, res: Response): Promise<void> {
    const { promptId } = req.validated.params as PromptIdParam;
    res.json(await agentsService.activatePrompt(promptId));
  },

  // ── Question types ──

  async listQuestionTypes(_req: Request, res: Response): Promise<void> {
    res.json(await agentsService.listQuestionTypes());
  },

  async updateQuestionType(req: Request, res: Response): Promise<void> {
    const { type } = req.validated.params as QuestionTypeParam;
    const body = req.validated.body as UpdateQuestionTypeBody;
    res.json(await agentsService.updateQuestionType(type, body));
  },
};
