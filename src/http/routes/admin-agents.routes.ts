import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  agentsController,
  spawnJobBodySchema,
  jobIdParamSchema,
  taskIdParamSchema,
  listJobsQuerySchema,
  setBudgetBodySchema,
  promptRoleParamSchema,
  promptIdParamSchema,
  promptTypeQuerySchema,
  savePromptBodySchema,
  questionTypeParamSchema,
  updateQuestionTypeBodySchema,
  scheduleIdParamSchema,
  updateScheduleBodySchema,
  reviewQuestionIdParamSchema,
} from '../../modules/agents/index.js';

// Admin-only: the CMS "Agents" section. Spawn generation jobs, monitor runs,
// review results. Reads/writes the agents schema; the VPS producer processes
// queued jobs out of band.
const router = Router();
router.use(authMiddleware, requireRole('admin'));

// jobs
router.get('/jobs', validate({ query: listJobsQuerySchema }), agentsController.listJobs);
router.post('/jobs', validate({ body: spawnJobBodySchema }), agentsController.spawn);
router.get('/jobs/:jobId', validate({ params: jobIdParamSchema }), agentsController.getJob);
router.delete('/jobs/:jobId', validate({ params: jobIdParamSchema }), agentsController.cancel);
router.get('/jobs/:jobId/tasks', validate({ params: jobIdParamSchema }), agentsController.tasks);
router.get('/jobs/:jobId/events', validate({ params: jobIdParamSchema }), agentsController.events);

// tasks
router.post('/tasks/:taskId/retry', validate({ params: taskIdParamSchema }), agentsController.retryTask);

// monitor + budget
router.get('/monitor', agentsController.monitor);
router.get('/activity', agentsController.activity);
router.get('/stats', agentsController.stats);
router.get('/budget', agentsController.budget);
router.patch('/budget', validate({ body: setBudgetBodySchema }), agentsController.setBudget);

// schedules (recurring jobs: daily-challenge cron config + run history + run-now)
router.get('/schedules', agentsController.listSchedules);
router.patch('/schedules/:id', validate({ params: scheduleIdParamSchema, body: updateScheduleBodySchema }), agentsController.updateSchedule);
router.get('/schedules/:id/runs', validate({ params: scheduleIdParamSchema }), agentsController.scheduleRuns);
router.post('/schedules/:id/run-now', validate({ params: scheduleIdParamSchema }), agentsController.runScheduleNow);

// review queue (agent-generated draft questions awaiting editor approval)
router.get('/review', agentsController.reviewQueue);
router.get('/review/count', agentsController.reviewCount);
router.post('/review/:questionId/approve', validate({ params: reviewQuestionIdParamSchema }), agentsController.approveQuestion);
router.post('/review/:questionId/reject', validate({ params: reviewQuestionIdParamSchema }), agentsController.rejectQuestion);

// sub-agent roster (the 4 agents: description, model, prompt preview, live stats)
router.get('/roster', agentsController.roster);

// editable sub-agent prompts (type-aware: optional ?type=<question type>)
router.get('/prompts', validate({ query: promptTypeQuerySchema }), agentsController.listPrompts);
router.get('/prompts/:role/history', validate({ params: promptRoleParamSchema, query: promptTypeQuerySchema }), agentsController.promptHistory);
router.put('/prompts/:role', validate({ params: promptRoleParamSchema, body: savePromptBodySchema }), agentsController.savePrompt);
router.post('/prompts/:promptId/activate', validate({ params: promptIdParamSchema }), agentsController.activatePrompt);

// question types (config-driven: enable/disable + edit description)
router.get('/question-types', agentsController.listQuestionTypes);
router.patch('/question-types/:type', validate({ params: questionTypeParamSchema, body: updateQuestionTypeBodySchema }), agentsController.updateQuestionType);

export const adminAgentsRoutes = router;
