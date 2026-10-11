import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { NotFoundError } from '../../core/errors.js';
import {
  assertFootballGridSoloTicket,
  footballGridSoloService,
  signFootballGridSoloTicket,
} from './football-grid-solo.service.js';
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
    res.setHeader('Cache-Control', 'no-store');
    res.json({ board, ticket: signFootballGridSoloTicket(board.boardId, Date.now()) });
  },

  async answer(req: Request, res: Response): Promise<void> {
    assertEnabled();
    const body = req.validated.body as FootballGridSoloAnswerInput;
    assertFootballGridSoloTicket(body.boardId, body.ticket, Date.now());
    res.json(await footballGridSoloService.judge(body));
  },

  async options(req: Request, res: Response): Promise<void> {
    assertEnabled();
    const body = req.validated.body as FootballGridSoloOptionsInput;
    assertFootballGridSoloTicket(body.boardId, body.ticket, Date.now());
    res.json({ options: await footballGridSoloService.options(body) });
  },
};
