import type { Request, Response } from 'express';
import { hqService } from './hq.service.js';
import type {
  ApproveTaskBody,
  CreateMemberBody,
  CreateMessageBody,
  CreateScheduleBody,
  CreateTaskBody,
  IdParam,
  ListEventsQuery,
  ListMembersQuery,
  ListRunsQuery,
  ListTasksQuery,
  MarkInboxReadBody,
  RejectTaskBody,
  UpdateMemberBody,
  UpdateScheduleBody,
  UpdateSettingsBody,
  UpdateTaskBody,
} from './hq.schemas.js';

// Admin controller for the CMS "HQ" section. Thin HTTP ↔ service layer.
const id = (req: Request) => (req.validated.params as IdParam).id;
const userId = (req: Request) => req.user?.id ?? null;

export const hqController = {
  async overview(req: Request, res: Response): Promise<void> {
    res.json(await hqService.overview(userId(req)));
  },

  // members
  async listMembers(req: Request, res: Response): Promise<void> {
    const { includeArchived } = req.validated.query as ListMembersQuery;
    res.json(await hqService.listMembers(includeArchived));
  },
  async createMember(req: Request, res: Response): Promise<void> {
    res.status(201).json(await hqService.createMember(req.validated.body as CreateMemberBody, userId(req)));
  },
  async getMember(req: Request, res: Response): Promise<void> {
    res.json(await hqService.getMember(id(req)));
  },
  async updateMember(req: Request, res: Response): Promise<void> {
    res.json(await hqService.updateMember(id(req), req.validated.body as UpdateMemberBody, userId(req)));
  },
  async syncHumans(_req: Request, res: Response): Promise<void> {
    res.json(await hqService.syncHumans());
  },

  // tasks
  async listTasks(req: Request, res: Response): Promise<void> {
    res.json(await hqService.listTasks(req.validated.query as ListTasksQuery));
  },
  async createTask(req: Request, res: Response): Promise<void> {
    res.status(201).json(await hqService.createTask(req.validated.body as CreateTaskBody, userId(req)));
  },
  async getTask(req: Request, res: Response): Promise<void> {
    res.json(await hqService.getTask(id(req)));
  },
  async updateTask(req: Request, res: Response): Promise<void> {
    res.json(await hqService.updateTask(id(req), req.validated.body as UpdateTaskBody, userId(req)));
  },
  async approveTask(req: Request, res: Response): Promise<void> {
    res.json(await hqService.approveTask(id(req), (req.validated.body ?? {}) as ApproveTaskBody, userId(req)));
  },
  async rejectTask(req: Request, res: Response): Promise<void> {
    res.json(await hqService.rejectTask(id(req), req.validated.body as RejectTaskBody, userId(req)));
  },
  async runTask(req: Request, res: Response): Promise<void> {
    res.json(await hqService.runTask(id(req), userId(req)));
  },
  async postMessage(req: Request, res: Response): Promise<void> {
    res.status(201).json(await hqService.postMessage(id(req), req.validated.body as CreateMessageBody, userId(req)));
  },

  // runs / events
  async listRuns(req: Request, res: Response): Promise<void> {
    res.json(await hqService.listRuns(req.validated.query as ListRunsQuery));
  },
  async getRun(req: Request, res: Response): Promise<void> {
    res.json(await hqService.getRun(id(req)));
  },
  async listEvents(req: Request, res: Response): Promise<void> {
    res.json(await hqService.listEvents(req.validated.query as ListEventsQuery));
  },

  // schedules
  async listSchedules(_req: Request, res: Response): Promise<void> {
    res.json(await hqService.listSchedules());
  },
  async createSchedule(req: Request, res: Response): Promise<void> {
    res.status(201).json(await hqService.createSchedule(req.validated.body as CreateScheduleBody, userId(req)));
  },
  async updateSchedule(req: Request, res: Response): Promise<void> {
    res.json(await hqService.updateSchedule(id(req), req.validated.body as UpdateScheduleBody, userId(req)));
  },
  async deleteSchedule(req: Request, res: Response): Promise<void> {
    await hqService.deleteSchedule(id(req), userId(req));
    res.status(204).send();
  },
  async runScheduleNow(req: Request, res: Response): Promise<void> {
    res.status(201).json(await hqService.runScheduleNow(id(req), userId(req)));
  },

  // settings
  async getSettings(_req: Request, res: Response): Promise<void> {
    res.json(await hqService.getSettings());
  },
  async updateSettings(req: Request, res: Response): Promise<void> {
    res.json(await hqService.updateSettings(req.validated.body as UpdateSettingsBody, userId(req)));
  },

  // inbox
  async inbox(req: Request, res: Response): Promise<void> {
    res.json(await hqService.inbox(userId(req)));
  },
  async markInboxRead(req: Request, res: Response): Promise<void> {
    const { ids } = (req.validated.body ?? {}) as MarkInboxReadBody;
    await hqService.markInboxRead(ids, userId(req));
    res.status(204).send();
  },
};
