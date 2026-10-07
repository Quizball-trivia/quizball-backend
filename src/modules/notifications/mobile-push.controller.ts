import type {Request,Response,NextFunction} from 'express';
import {AuthenticationError,AuthorizationError,AppError,ErrorCode} from '../../core/errors.js';
import {config} from '../../core/config.js';
import {mobilePushRepo} from './mobile-push.repo.js';
import type {PushDeviceInput,PushUnregisterInput,PushPreferencesUpdate,PushCampaignInput} from './mobile-push.schemas.js';
import {pushUserAllowed} from './mobile-push.worker.js';
export function requirePushBearer(req:Request,_res:Response,next:NextFunction) {
  if (!/^Bearer\s+\S+$/i.test(req.headers.authorization??'')) throw new AuthenticationError('Bearer authentication required');
  // Also reject partner identities when this isolated module runs against a
  // schema that does not yet include the optional partner account fields.
  const account: {partner_slug?:unknown;role?:string}|undefined=req.user;
  if (account?.partner_slug!=null||account?.role==='partner_staff') throw new AuthorizationError('Quizball account required');
  next();
}
export const mobilePushController={
  async register(req:Request,res:Response) {
    if (!config.PUSH_TOKEN_ENCRYPTION_KEY || !config.PUSH_TOKEN_FINGERPRINT_KEY) throw new AppError('Push setup unavailable',503,ErrorCode.EXTERNAL_SERVICE_ERROR);
    const registered=await mobilePushRepo.register(req.user!.id,req.validated.body as PushDeviceInput);res.json({registered});
  },
  async unregister(req:Request,res:Response) {
    if (!config.PUSH_TOKEN_ENCRYPTION_KEY || !config.PUSH_TOKEN_FINGERPRINT_KEY) throw new AppError('Push setup unavailable',503,ErrorCode.EXTERNAL_SERVICE_ERROR);
    await mobilePushRepo.unregister(req.user!.id,req.validated.body as PushUnregisterInput);res.json({unregistered:true});
  },
  async preferences(req:Request,res:Response) {res.json(await mobilePushRepo.getPreferences(req.user!.id));},
  async updatePreferences(req:Request,res:Response) {res.json(await mobilePushRepo.updatePreferences(req.user!.id,req.validated.body as PushPreferencesUpdate));},
  async test(req:Request,res:Response) {
    if (!config.PUSH_DELIVERY_ENABLED||!pushUserAllowed(req.user!.id)) throw new AppError('Push testing is not enabled',503,ErrorCode.EXTERNAL_SERVICE_ERROR);
    res.status(202).json(await mobilePushRepo.queueTest(req.user!.id));
  },
  async preview(req:Request,res:Response) {
    if(req.user?.role!=='admin') throw new AuthorizationError('Admin role required');
    res.json(await mobilePushRepo.previewCampaign());
  },
  async campaign(req:Request,res:Response) {
    if(req.user?.role!=='admin') throw new AuthorizationError('Admin role required');
    if (config.NODE_ENV!=='prod') throw new AuthorizationError('Campaigns are production-only; use self test on staging');
    if (!config.PUSH_DELIVERY_ENABLED) throw new AppError('Push delivery is disabled',503,ErrorCode.EXTERNAL_SERVICE_ERROR);
    await mobilePushRepo.ensureProviderKey();
    res.status(202).json(await mobilePushRepo.queueCampaign(req.user!.id,req.validated.body as PushCampaignInput));
  },
};
