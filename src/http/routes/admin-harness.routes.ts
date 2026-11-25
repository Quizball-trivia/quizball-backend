import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { harnessController, policyKeyParamSchema, setPolicyBodySchema, updateHarnessSettingsBodySchema } from '../../modules/harness/index.js';

// Admin-only: the CMS Content tab for the new agent harness (`harness` schema).
// Reading is open to every CMS admin; changing settings and policies is for
// HQ owners only (checked in the service).
const router = Router();
router.use(authMiddleware, requireRole('admin'));

router.get('/overview', harnessController.overview);
router.patch('/settings', validate({ body: updateHarnessSettingsBodySchema }), harnessController.updateSettings);
router.put('/policies/:key', validate({ params: policyKeyParamSchema, body: setPolicyBodySchema }), harnessController.setPolicy);

export { router as adminHarnessRoutes };
