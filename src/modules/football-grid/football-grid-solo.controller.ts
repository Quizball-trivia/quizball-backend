import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { NotFoundError } from '../../core/errors.js';
import { noteSoloGap } from './football-grid-solo-gaps.js';
import {
  assertFootballGridSoloTicket,
  footballGridSoloService,
  signFootballGridSoloTicket,
} from './football-grid-solo.service.js';
import { footballGridJudge } from './football-grid-judge.service.js';
import type {
  FootballGridSoloAnswerInput,
  FootballGridSoloBoardInput,
  FootballGridSoloOptionsInput,
} from './football-grid-solo.schemas.js';

function assertEnabled(): void {
  if (!config.FOOTBALL_GRID_CONTENT_ENABLED) throw new NotFoundError('Football Tic Tac Toe is not available');
}

export const footballGridSoloController = {
  async dealBoard(req: Request, res: Response): Promise<void> {
    assertEnabled();
    const body = req.validated.body as FootballGridSoloBoardInput;
    const board = await footballGridSoloService.dealBoard({
      theme: body.theme,
      difficulty: body.difficulty === 'mixed' ? null : body.difficulty,
      excludeBoardIds: body.excludeBoardIds,
    });
    // A same-phone game pins the shared judge version once, here; every answer of it is judged by that version.
    const judgeVersionId = await footballGridJudge.pinForNew(undefined, { boardId: board.boardId, surface: 'solo', cohortKey: randomUUID(), requireChoice: true });
    // The board under its version loads while the player reads the clues (background; the answer retries it).
    if (judgeVersionId) void footballGridJudge.getJudgedBoard(board.boardId, judgeVersionId).catch(() => undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ board, ticket: signFootballGridSoloTicket(board.boardId, Date.now(), judgeVersionId) });
  },

  async answer(req: Request, res: Response): Promise<void> {
    assertEnabled();
    const body = req.validated.body as FootballGridSoloAnswerInput;
    const { judgeVersionId } = assertFootballGridSoloTicket(body.boardId, body.ticket, Date.now());
    const verdict = await footballGridSoloService.judge({ ...body, judgeVersionId });
    res.json(verdict);
    if (!body.optionPlayerId && (verdict.outcome === 'wrong' || verdict.outcome === 'ambiguous')) {
      noteSoloGap({ boardId: body.boardId, cellIndex: body.cellIndex, text: body.text, usedPlayerIds: body.usedPlayerIds, judgeVersionId });
    }
  },

  async options(req: Request, res: Response): Promise<void> {
    assertEnabled();
    const body = req.validated.body as FootballGridSoloOptionsInput;
    const { judgeVersionId } = assertFootballGridSoloTicket(body.boardId, body.ticket, Date.now());
    res.json({ options: await footballGridSoloService.options({ ...body, judgeVersionId }) });
  },
};
