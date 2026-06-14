import { Router } from 'express';
import { validate } from '../middleware/index.js';
import { feedbackController, submitFeedbackBodySchema } from '../../modules/feedback/index.js';

// Public (no auth) so logged-out visitors can report bugs / contact us.
// Spam is bounded by the dedicated feedback rate-limiter in app.ts.
const router = Router();

router.post('/', validate({ body: submitFeedbackBodySchema }), feedbackController.submit);

export const feedbackRoutes = router;
