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
router.get('/budget', agentsController.budget);
router.patch('/budget', validate({ body: setBudgetBodySchema }), agentsController.setBudget);

export const adminAgentsRoutes = router;
