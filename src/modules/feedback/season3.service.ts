import { config } from '../../core/config.js';
import { BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { season3Repo } from './season3.repo.js';
import type { Season3Response } from './season3.schemas.js';
import type { FeedbackSubmitter } from './feedback.service.js';

export function season3ProductionEmail(): boolean {
  return config.NODE_ENV==='prod' && config.SUPABASE_URL==='https://lfbwhxvwubzeqkztghok.supabase.co';
}
export function escapeSeason3Html(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export const season3Service = {
  claim(userId:string,matchId:string) {
    if(process.env.SEASON3_SURVEYS_ENABLED==='false') return Promise.resolve({kind:null,saved:false});
    return season3Repo.act(userId,matchId,'claim');
  },
  dismiss(userId:string,matchId:string) { return season3Repo.act(userId,matchId,'dismiss'); },
  async submit(userId:string,input:Season3Response,user:FeedbackSubmitter) {
    const payload = input.kind==='idea' ? {
      from:config.RESEND_FROM_EMAIL,to:['nika@quizball.io'],subject:'[Quizball] Season 3 game mode idea',
      html:`<h2>Season 3 game mode feedback</h2><p>Player: ${escapeSeason3Html(user.username??userId)}</p><p>Account: ${escapeSeason3Html(userId)}</p><p>Language: ${input.locale}</p><p style="white-space:pre-wrap">${escapeSeason3Html(input.idea)}</p>`,
      ...(user.email?{reply_to:user.email}:{}),
    }:undefined;
    const result = await season3Repo.act(userId,input.matchId,'submit',input,payload,season3ProductionEmail());
    if(!result.saved) throw new BadRequestError('Survey expired or unavailable');
    return {ok:true};
  },
};

let busy=false;
export async function deliverSeason3Feedback() {
  if(busy || !season3ProductionEmail() || !config.RESEND_API_KEY) return;
  busy=true;
  try {
    for(let i=0;i<10;i++) {
      const row=await season3Repo.claimEmail(); if(!row) break;
      let accepted=false;
      try {
        const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`season3-feedback/${row.id}`},body:JSON.stringify(row.email_payload),signal:AbortSignal.timeout(10000)});
        accepted=response.ok;
        if(!accepted) logger.warn({status:response.status},'Season 3 feedback email pending retry');
      } catch { logger.warn('Season 3 feedback email transport failure'); }
      await season3Repo.finishEmail(row.id,row.claim_token,accepted);
    }
  } finally { busy=false; }
}
let workerTimer: ReturnType<typeof setInterval> | undefined;
let workerRun: Promise<void> | undefined;
export function startSeason3FeedbackWorker() {
  if(workerTimer) return;
  workerTimer=setInterval(()=>{
    if(workerRun) return;
    workerRun=deliverSeason3Feedback()
      .catch(()=>logger.error('Season 3 feedback worker failed'))
      .finally(()=>{workerRun=undefined;});
  },60000);
  workerTimer.unref();
}
export async function stopSeason3FeedbackWorker() {
  clearInterval(workerTimer);
  workerTimer=undefined;
  await workerRun;
}
