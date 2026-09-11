import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate, authMiddleware } from '../middleware/index.js';
import { season3MatchSchema, season3ResponseSchema } from '../../modules/feedback/season3.schemas.js';
import { season3Service } from '../../modules/feedback/season3.service.js';
import { feedbackController, submitFeedbackBodySchema } from '../../modules/feedback/index.js';

// Public (no auth) so logged-out visitors can report bugs / contact us.
// Spam is bounded by the dedicated feedback rate-limiter in app.ts.
const router = Router();
router.use('/season3',authMiddleware,rateLimit({windowMs:600000,max:30,keyGenerator:req=>req.user!.id,standardHeaders:true,legacyHeaders:false}));

router.post('/season3/claim',authMiddleware,validate({body:season3MatchSchema}),async(req,res)=>{
  res.json(await season3Service.claim(req.user!.id,season3MatchSchema.parse(req.validated.body).matchId));
});
router.post('/season3/dismiss',authMiddleware,validate({body:season3MatchSchema}),async(req,res)=>{
  await season3Service.dismiss(req.user!.id,season3MatchSchema.parse(req.validated.body).matchId);res.json({ok:true});
});
router.post('/season3',authMiddleware,validate({body:season3ResponseSchema}),async(req,res)=>{
  res.json(await season3Service.submit(req.user!.id,season3ResponseSchema.parse(req.validated.body),{userId:req.user!.id,username:req.user!.nickname,email:req.user!.email}));
});

router.post('/', validate({ body: submitFeedbackBodySchema }), feedbackController.submit);

export const feedbackRoutes = router;
