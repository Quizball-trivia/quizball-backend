import { sql } from '../../db/index.js';
import { ConflictError } from '../../core/errors.js';
import type { Season3Response } from './season3.schemas.js';

type Kind = 'vote' | 'idea';
export const season3Repo = {
  async act(userId: string, matchId: string, action: 'claim' | 'dismiss' | 'submit', input?: Season3Response, payload?: object, production=false) {
    return sql.begin(async transaction => {
      const tx=transaction as unknown as typeof sql;
      await tx`INSERT INTO season3_survey_state(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
      const [state] = await tx`SELECT *, snoozed_until > now() AS snoozed,
        last_prompt_at > now()-interval '1 day' AS recently_prompted
        FROM season3_survey_state WHERE user_id=${userId} FOR UPDATE`;
      const responses = await tx`SELECT kind,created_at FROM season3_survey_responses WHERE user_id=${userId}`;
      if(action==='submit' && responses.some(r=>r.kind===input?.kind)) return { kind:null, saved:true };
      if(action==='dismiss') {
        if(state!.last_match_id===matchId) await tx`UPDATE season3_survey_state SET snoozed_until=now()+interval '7 days' WHERE user_id=${userId}`;
        return { kind:null, saved:false };
      }
      const [match] = await tx`SELECT m.ended_at FROM matches m JOIN match_players p ON p.match_id=m.id
        WHERE m.id=${matchId} AND p.user_id=${userId} AND m.mode='ranked' AND m.status='completed'
        AND m.is_dev=false AND m.ended_at > now()-interval '30 minutes'`;
      if(!match || state!.snoozed) return { kind:null, saved:false };
      let kind: Kind | null = state!.last_match_id===matchId ? state!.assigned_kind as Kind : null;
      if(state!.last_match_id!==matchId) {
        if(state!.recently_prompted) return {kind:null,saved:false};
        const vote = responses.find(r=>r.kind==='vote');
        kind = !vote ? 'vote' : !responses.some(r=>r.kind==='idea') && new Date(match.ended_at)>new Date(vote.created_at) ? 'idea' : null;
        if(action==='claim' && kind) await tx`UPDATE season3_survey_state SET last_match_id=${matchId},assigned_kind=${kind},last_prompt_at=now() WHERE user_id=${userId}`;
        else return {kind:null,saved:false};
      }
      if(responses.some(r=>r.kind===kind)) return {kind:null,saved:false};
      if(action==='submit') {
        if(!input || input.kind!==kind) throw new ConflictError('Survey is not assigned for this match');
        await tx`INSERT INTO season3_survey_responses(user_id,match_id,kind,locale,remove_order,remove_who,idea,email_payload,email_status)
          VALUES(${userId},${matchId},${input.kind},${input.locale},${input.kind==='vote'?input.removeOrder:null},
          ${input.kind==='vote'?input.removeWho:null},${input.kind==='idea'?input.idea:null},${payload?tx.json(payload as never):null},
          ${input.kind==='vote'?'not_required':production?'pending':'suppressed'})`;
        return {kind:null,saved:true};
      }
      return {kind,saved:false};
    });
  },
  async claimEmail() {
    await sql`UPDATE season3_survey_responses SET email_status='review' WHERE email_status IN ('pending','sending') AND first_attempt_at < now()-interval '23 hours'`;
    const [row] = await sql`UPDATE season3_survey_responses SET email_status='sending',claim_token=gen_random_uuid(),attempted_at=now(),first_attempt_at=coalesce(first_attempt_at,now())
      WHERE id=(SELECT id FROM season3_survey_responses WHERE email_status IN ('pending','sending')
      AND (attempted_at IS NULL OR attempted_at < now()-interval '5 minutes')
      AND (first_attempt_at IS NULL OR first_attempt_at > now()-interval '23 hours')
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,email_payload,claim_token`;
    return row;
  },
  async finishEmail(id:string,claimToken:string,accepted:boolean) {
    await sql`UPDATE season3_survey_responses SET email_status=${accepted?'sent':'pending'},sent_at=${accepted?new Date():null}
      WHERE id=${id} AND claim_token=${claimToken} AND email_status='sending'`;
  },
};
