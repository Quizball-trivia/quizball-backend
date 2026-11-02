import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  hqController,
  idParamSchema,
  listMembersQuerySchema,
  createMemberBodySchema,
  updateMemberBodySchema,
  listTasksQuerySchema,
  createTaskBodySchema,
  updateTaskBodySchema,
  approveTaskBodySchema,
  rejectTaskBodySchema,
  createMessageBodySchema,
  listRunsQuerySchema,
  listEventsQuerySchema,
  createScheduleBodySchema,
  updateScheduleBodySchema,
  updateSettingsBodySchema,
  markInboxReadBodySchema,
  pulseQuerySchema,
  standupQuerySchema,
  listGoalsQuerySchema,
  createGoalBodySchema,
  updateGoalBodySchema,
  acceptProposalBodySchema,
  declineProposalBodySchema,
  analyticsQuerySchema,
} from '../../modules/hq/index.js';

// Admin-only: the CMS "HQ" section — people + AI agent employees on one task
// board. Reads/writes the hq schema; the VPS `hq-worker` executes agent tasks
// out of band.
const router = Router();
router.use(authMiddleware, requireRole('admin'));

router.get('/overview', hqController.overview);
router.get('/departments', hqController.departments);

// daily standup (goals + agent reports + ideas waiting for the CEO)
router.get('/standup', validate({ query: standupQuerySchema }), hqController.standup);
router.post('/standup/run', hqController.runStandup);

// goals
router.get('/goals', validate({ query: listGoalsQuerySchema }), hqController.listGoals);
router.post('/goals', validate({ body: createGoalBodySchema }), hqController.createGoal);
router.patch('/goals/:id', validate({ params: idParamSchema, body: updateGoalBodySchema }), hqController.updateGoal);
router.delete('/goals/:id', validate({ params: idParamSchema }), hqController.deleteGoal);

// analytics
router.get('/analytics', validate({ query: analyticsQuerySchema }), hqController.analytics);
router.get('/analytics/posthog', validate({ query: analyticsQuerySchema }), hqController.posthog);
router.get('/pulse', validate({ query: pulseQuerySchema }), hqController.pulse);

// members (team)
router.get('/members', validate({ query: listMembersQuerySchema }), hqController.listMembers);
router.post('/members', validate({ body: createMemberBodySchema }), hqController.createMember);
router.post('/members/sync-humans', hqController.syncHumans);
router.get('/members/:id', validate({ params: idParamSchema }), hqController.getMember);
router.patch('/members/:id', validate({ params: idParamSchema, body: updateMemberBodySchema }), hqController.updateMember);

// tasks (board)
router.get('/tasks', validate({ query: listTasksQuerySchema }), hqController.listTasks);
router.post('/tasks', validate({ body: createTaskBodySchema }), hqController.createTask);
router.get('/tasks/:id', validate({ params: idParamSchema }), hqController.getTask);
router.patch('/tasks/:id', validate({ params: idParamSchema, body: updateTaskBodySchema }), hqController.updateTask);
router.post('/tasks/:id/approve', validate({ params: idParamSchema, body: approveTaskBodySchema }), hqController.approveTask);
router.post('/tasks/:id/reject', validate({ params: idParamSchema, body: rejectTaskBodySchema }), hqController.rejectTask);
router.post('/tasks/:id/run', validate({ params: idParamSchema }), hqController.runTask);
router.post('/tasks/:id/accept-proposal', validate({ params: idParamSchema, body: acceptProposalBodySchema }), hqController.acceptProposal);
router.post('/tasks/:id/decline-proposal', validate({ params: idParamSchema, body: declineProposalBodySchema }), hqController.declineProposal);
router.post('/tasks/:id/messages', validate({ params: idParamSchema, body: createMessageBodySchema }), hqController.postMessage);

// runs + activity
router.get('/runs', validate({ query: listRunsQuerySchema }), hqController.listRuns);
router.get('/runs/:id', validate({ params: idParamSchema }), hqController.getRun);
router.get('/events', validate({ query: listEventsQuerySchema }), hqController.listEvents);

// schedules
router.get('/schedules', hqController.listSchedules);
router.post('/schedules', validate({ body: createScheduleBodySchema }), hqController.createSchedule);
router.patch('/schedules/:id', validate({ params: idParamSchema, body: updateScheduleBodySchema }), hqController.updateSchedule);
router.delete('/schedules/:id', validate({ params: idParamSchema }), hqController.deleteSchedule);
router.post('/schedules/:id/run-now', validate({ params: idParamSchema }), hqController.runScheduleNow);

// settings (kill-switch + caps)
router.get('/settings', hqController.getSettings);
router.patch('/settings', validate({ body: updateSettingsBodySchema }), hqController.updateSettings);

// inbox (messages addressed to the signed-in admin)
router.get('/inbox', hqController.inbox);
router.post('/inbox/read', validate({ body: markInboxReadBodySchema }), hqController.markInboxRead);

export const adminHqRoutes = router;
