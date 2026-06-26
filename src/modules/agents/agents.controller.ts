import type { Request, Response } from 'express';
import { agentsService } from './agents.service.js';
import type { JobIdParam, ListJobsQuery, SetBudgetBody, SpawnJobBody, TaskIdParam } from './agents.schemas.js';

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
};
