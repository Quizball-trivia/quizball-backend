import type { Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { dayQuerySchema, moveSchema, playerOf, type DayQuery, type MoveRequest, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import { draftEras, draftFormations } from './draft.content.js';
import { boardTeam, draftDaily } from './draft-daily.service.js';
import { draftChallenges, draftFree, draftTies, type RunSource } from './draft-play.service.js';
import type { FormationId, Variant } from './draft.rules.js';

export const pickSchema = moveSchema.extend({ playerId: z.string().min(1).max(100), slotId: z.string().min(1).max(10).optional() });
export const academySchema = moveSchema.extend({ slotId: z.string().min(1).max(10) });
export const respinSchema = moveSchema.extend({ kind: z.enum(['club', 'season']) });
export const freeStartSchema = z.object({
  leagueId: z.string().min(1).max(20), era: z.enum(draftEras), formation: z.enum(draftFormations as [FormationId, ...FormationId[]]), variant: z.enum(['budget', 'classic', 'knowledge']),
});
const daySchema = dayQuerySchema.shape.day;
export const teamQuerySchema = z.object({ day: daySchema.unwrap(), userId: z.string().uuid() });
export const boardTieSchema = z.object({ day: daySchema.unwrap(), userId: z.string().uuid() });
export const runQuerySchema = z.object({ runId: z.string().uuid() });
export const challengeCreateSchema = z.union([
  z.object({ variant: z.enum(['budget', 'classic', 'knowledge']), day: daySchema.unwrap() }).strict(),
  z.object({ runId: z.string().uuid() }).strict(),
]);
export const challengeParamsSchema = z.object({ code: z.string().min(6).max(16).regex(/^[A-Za-z0-9_-]+$/) });

const nicknameOf = async (userId: string): Promise<string> => {
  const [row] = await sql<Array<{ nickname: string | null }>>`SELECT nickname FROM users WHERE id = ${userId}`;
  return row?.nickname || 'Player';
};
const myName = async (req: Request): Promise<string> => (req.user ? nicknameOf(req.user.id) : 'Guest');

/** The daily's moves and reads for one version. */
export function dailyController(variant: Variant) {
  const game = draftDaily[variant];
  const body = <T>(req: Request) => req.validated.body as T;
  return {
    start: async (req: Request, res: Response) => { const b = body<StartRequest>(req); res.json(await game.start(b.day, playerOf(req), b.contentVersion)); },
    spin: async (req: Request, res: Response) => { const b = body<MoveRequest>(req); res.json(await game.spin(playerOf(req), b.runId, b.version)); },
    pick: async (req: Request, res: Response) => { const b = body<z.infer<typeof pickSchema>>(req); res.json(await game.pick(playerOf(req), b.runId, b.version, b.playerId, b.slotId)); },
    academy: async (req: Request, res: Response) => { const b = body<z.infer<typeof academySchema>>(req); res.json(await game.academy(playerOf(req), b.runId, b.version, b.slotId)); },
    respin: async (req: Request, res: Response) => { const b = body<z.infer<typeof respinSchema>>(req); res.json(await game.respin(playerOf(req), b.runId, b.version, b.kind)); },
    undo: async (req: Request, res: Response) => { const b = body<MoveRequest>(req); res.json(await game.undo(playerOf(req), b.runId, b.version)); },
    finish: async (req: Request, res: Response) => { const b = body<MoveRequest>(req); res.json(await game.finish(playerOf(req), b.runId, b.version)); },
    current: async (req: Request, res: Response) => { const q = req.validated.query as DayQuery; res.setHeader('Cache-Control', 'private, no-store'); res.json(await game.current(playerOf(req), q.day)); },
    boards: async (_req: Request, res: Response) => { const boards = await game.boards(); res.setHeader('Cache-Control', 'public, max-age=300'); res.json(boards); },
    /** Nothing to review: a closed day's teams are on its board. */
    review: async (_req: Request, res: Response) => { res.status(404).end(); },
    leaderboard: async (req: Request, res: Response) => {
      const q = req.validated.query as DayQuery;
      const board = await game.leaderboard(q.day, req.user?.id ?? null);
      const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
      res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
      res.json(board);
    },
    team: async (req: Request, res: Response) => {
      const q = req.validated.query as z.infer<typeof teamQuerySchema>;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await boardTeam(variant, playerOf(req), q.day, q.userId));
    },
    tie: async (req: Request, res: Response) => {
      const b = body<z.infer<typeof boardTieSchema>>(req);
      res.json(await draftTies.againstBoard(playerOf(req), variant, b.day, b.userId, await myName(req), await nicknameOf(b.userId)));
    },
  };
}

export const draftPlayController = {
  freeStart: async (req: Request, res: Response) => res.json(await draftFree.start(playerOf(req), req.validated.body as z.infer<typeof freeStartSchema>)),
  freeCurrent: async (req: Request, res: Response) => { res.setHeader('Cache-Control', 'private, no-store'); res.json(await draftFree.current(playerOf(req), (req.validated.query as z.infer<typeof runQuerySchema>).runId)); },
  freeSpin: async (req: Request, res: Response) => { const b = req.validated.body as MoveRequest; res.json(await draftFree.spin(playerOf(req), b.runId, b.version)); },
  freePick: async (req: Request, res: Response) => { const b = req.validated.body as z.infer<typeof pickSchema>; res.json(await draftFree.pick(playerOf(req), b.runId, b.version, b.playerId, b.slotId)); },
  freeAcademy: async (req: Request, res: Response) => { const b = req.validated.body as z.infer<typeof academySchema>; res.json(await draftFree.academy(playerOf(req), b.runId, b.version, b.slotId)); },
  freeRespin: async (req: Request, res: Response) => { const b = req.validated.body as z.infer<typeof respinSchema>; res.json(await draftFree.respin(playerOf(req), b.runId, b.version, b.kind)); },
  freeUndo: async (req: Request, res: Response) => { const b = req.validated.body as MoveRequest; res.json(await draftFree.undo(playerOf(req), b.runId, b.version)); },
  freeFinish: async (req: Request, res: Response) => { const b = req.validated.body as MoveRequest; res.json(await draftFree.finish(playerOf(req), b.runId, b.version)); },
  challengeCreate: async (req: Request, res: Response) => {
    const b = req.validated.body as z.infer<typeof challengeCreateSchema>;
    const source: RunSource = 'runId' in b ? { freeRunId: b.runId } : { daily: b.variant, day: b.day };
    res.json(await draftChallenges.create(playerOf(req), source, await myName(req)));
  },
  challengeRead: async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const viewer = req.user || req.guest ? playerOf(req) : null;
    res.json(await draftChallenges.read((req.validated.params as z.infer<typeof challengeParamsSchema>).code, viewer));
  },
  challengeAccept: async (req: Request, res: Response) => res.json(await draftChallenges.accept(playerOf(req), (req.validated.params as z.infer<typeof challengeParamsSchema>).code)),
  challengeTie: async (req: Request, res: Response) => res.json(await draftChallenges.tie(playerOf(req), (req.validated.params as z.infer<typeof challengeParamsSchema>).code, await myName(req))),
  myTies: async (req: Request, res: Response) => { res.setHeader('Cache-Control', 'private, no-store'); res.json(await draftTies.mine(playerOf(req))); },
};
