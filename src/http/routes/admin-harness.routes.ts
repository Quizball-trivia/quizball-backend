import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  applyAskBodySchema,
  briefParamSchema,
  createAskBodySchema,
  createEventBodySchema,
  createProposalBodySchema,
  idParamSchema,
  categoryParamSchema,
  createRequestBodySchema,
  harnessController,
  itemActionBodySchema,
  itemParamSchema,
  policyKeyParamSchema,
  setDirectionBodySchema,
  setPolicyBodySchema,
  setSteeringBodySchema,
  updateHarnessSettingsBodySchema,
} from '../../modules/harness/index.js';

// Admin-only: the CMS Content tab for the new agent harness (`harness` schema).
// Reading is open to every CMS admin; changing settings and policies is for
// HQ owners only, and steering (priorities, direction, orders, decisions on
// questions) for any active team member (both checked in the service).
const router = Router();
router.use(authMiddleware, requireRole('admin'));

router.get('/overview', harnessController.overview);
router.patch('/settings', validate({ body: updateHarnessSettingsBodySchema }), harnessController.updateSettings);
router.put('/policies/:key', validate({ params: policyKeyParamSchema, body: setPolicyBodySchema }), harnessController.setPolicy);

router.put('/steering/:categoryId', validate({ params: categoryParamSchema, body: setSteeringBodySchema }), harnessController.setSteering);
router.put('/direction', validate({ body: setDirectionBodySchema }), harnessController.setDirection);
router.post('/requests', validate({ body: createRequestBodySchema }), harnessController.createRequest);
router.post('/requests/:briefId/cancel', validate({ params: briefParamSchema }), harnessController.cancelRequest);
router.post('/items/:itemId/action', validate({ params: itemParamSchema, body: itemActionBodySchema }), harnessController.itemAction);
router.post('/events', validate({ body: createEventBodySchema }), harnessController.createEvent);
router.post('/events/:id/cancel', validate({ params: idParamSchema }), harnessController.cancelEvent);
router.post('/proposals', validate({ body: createProposalBodySchema }), harnessController.createProposal);
router.post('/proposals/:id/go-live', validate({ params: idParamSchema }), harnessController.proposalGoLive);
router.post('/proposals/:id/cancel', validate({ params: idParamSchema }), harnessController.cancelProposal);
router.post('/asks', validate({ body: createAskBodySchema }), harnessController.createAsk);
router.post('/asks/:id/apply', validate({ params: idParamSchema, body: applyAskBodySchema }), harnessController.applyAsk);
router.post('/asks/:id/dismiss', validate({ params: idParamSchema }), harnessController.dismissAsk);

export { router as adminHarnessRoutes };
