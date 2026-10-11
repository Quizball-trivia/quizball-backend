import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthorizationError, NotFoundError } from '../../core/errors.js';
import { resolveFootballGridAnswer } from './football-grid.answer-resolver.js';
import {
  buildFootballGridOptions,
  footballGridSecret,
  getFootballGridBoardPlayers,
  type FootballGridOption,
} from './football-grid-options.js';
import { footballGridRepo } from './football-grid.repo.js';
import { getAliasesByPlayerForRelease } from './football-grid.service.js';
import type {
  FootballGridAliasRecord,
  FootballGridBoardView,
  FootballGridDifficulty,
} from './football-grid.types.js';

const TICKET_TTL_MS = 6 * 60 * 60_000;
const CONTENT_CACHE_TTL_MS = 10 * 60_000;
const CONTENT_CACHE_MAX_ENTRIES = 256;

interface SoloBoardContent {
  aliases: FootballGridAliasRecord[];
  validPlayerIdsByCell: Map<number, string[]>;
  boardPlayerIds: string[];
  namesById: Map<string, { nameEn: string; nameKa: string | null }>;
}

const contentCache = new Map<string, { expiresAt: number; value: Promise<SoloBoardContent> }>();

async function loadContent(boardId: string): Promise<SoloBoardContent> {
  const context = await footballGridRepo.getBoardAnswersByBoard(boardId);
  if (!context) throw new NotFoundError('Football Grid board not found');
  const aliasesByPlayer = await getAliasesByPlayerForRelease(context.aliasReleaseId);
  const validPlayerIdsByCell = new Map<number, string[]>();
  const namesById = new Map<string, { nameEn: string; nameKa: string | null }>();
  for (const answer of context.answers) {
    const cell = validPlayerIdsByCell.get(answer.cellIndex) ?? [];
    cell.push(answer.footballPlayerId);
    validPlayerIdsByCell.set(answer.cellIndex, cell);
    namesById.set(answer.footballPlayerId, { nameEn: answer.playerNameEn, nameKa: answer.playerNameKa });
  }
  const boardPlayerIds = [...namesById.keys()];
  return {
    aliases: boardPlayerIds.flatMap((playerId) => aliasesByPlayer.get(playerId) ?? []),
    validPlayerIdsByCell,
    boardPlayerIds,
    namesById,
  };
}

function boardContent(boardId: string): Promise<SoloBoardContent> {
  const now = Date.now();
  const cached = contentCache.get(boardId);
  if (cached && cached.expiresAt > now) return cached.value;
  const entry = { expiresAt: now + CONTENT_CACHE_TTL_MS, value: loadContent(boardId) };
  contentCache.set(boardId, entry);
  entry.value.catch(() => {
    if (contentCache.get(boardId) === entry) contentCache.delete(boardId);
  });
  while (contentCache.size > CONTENT_CACHE_MAX_ENTRIES) {
    const oldest = contentCache.keys().next().value as string | undefined;
    if (!oldest) break;
    contentCache.delete(oldest);
  }
  return entry.value;
}

function ticketSignature(boardId: string, expiresAtMs: number): Buffer {
  return createHmac('sha256', footballGridSecret()).update(`football-grid-solo:${boardId}:${expiresAtMs}`).digest();
}

/**
 * Proof that this server dealt the board to the caller. Board ids are visible to both players of an online
 * match, so without it anyone could ask these endpoints about the board they are playing for rating.
 */
export function signFootballGridSoloTicket(boardId: string, nowMs: number): string {
  const expiresAtMs = nowMs + TICKET_TTL_MS;
  return `${expiresAtMs}.${ticketSignature(boardId, expiresAtMs).toString('hex')}`;
}

export function assertFootballGridSoloTicket(boardId: string, ticket: string, nowMs: number): void {
  const [expires, signature] = ticket.split('.');
  const expiresAtMs = Number(expires);
  const given = Buffer.from(signature ?? '', 'hex');
  const expected = Number.isSafeInteger(expiresAtMs) ? ticketSignature(boardId, expiresAtMs) : null;
  if (!expected || expiresAtMs < nowMs || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AuthorizationError('This board was not dealt to you, or the game has expired');
  }
}

export interface FootballGridSoloPlayer {
  playerId: string;
  name: string;
  nameKa: string | null;
  imageUrl: string | null;
}

export type FootballGridSoloVerdict =
  | { outcome: 'correct'; player: FootballGridSoloPlayer }
  | { outcome: 'wrong' | 'ambiguous' | 'already_used'; player: null };

/**
 * Tic Tac Toe without a server match: the caller (two people on one phone, or the daily grid) keeps the turns
 * and the claimed cells; this only deals boards and judges one answer at a time. It never reveals an answer the
 * caller did not name, except the four options of a pick-from-four turn.
 */
export const footballGridSoloService = {
  async dealBoard(input: {
    theme: string;
    difficulty: FootballGridDifficulty | null;
    excludeBoardIds: string[];
  }): Promise<FootballGridBoardView> {
    const profile = input.difficulty ?? 'gentle';
    let boardId = await footballGridRepo.selectSoloBoardId({ theme: input.theme, profile, excludeBoardIds: input.excludeBoardIds });
    if (!boardId && input.excludeBoardIds.length > 0) {
      boardId = await footballGridRepo.selectSoloBoardId({ theme: input.theme, profile, excludeBoardIds: [] });
    }
    if (!boardId && input.theme !== 'european') {
      boardId = await footballGridRepo.selectSoloBoardId({ theme: 'european', profile, excludeBoardIds: input.excludeBoardIds });
    }
    if (!boardId) throw new NotFoundError('No Football Grid board is available');
    return footballGridRepo.getBoardView(boardId);
  },

  async judge(input: {
    boardId: string;
    cellIndex: number;
    text: string;
    usedPlayerIds: readonly string[];
    /** Set when the answer was picked from four options: the footballer picked. */
    optionPlayerId?: string;
  }): Promise<FootballGridSoloVerdict> {
    const content = await boardContent(input.boardId);
    const cellPlayerIds = content.validPlayerIdsByCell.get(input.cellIndex) ?? [];
    const used = new Set(input.usedPlayerIds);
    let playerId: string | null = null;
    let outcome: FootballGridSoloVerdict['outcome'];
    if (input.optionPlayerId) {
      outcome = cellPlayerIds.includes(input.optionPlayerId) ? 'correct' : 'wrong';
      playerId = input.optionPlayerId;
    } else {
      const resolved = resolveFootballGridAnswer({
        submittedText: input.text,
        aliases: content.aliases,
        validPlayerIds: cellPlayerIds,
        boardPlayerIds: content.boardPlayerIds,
        usedPlayerIds: [],
        validPlayerNames: cellPlayerIds.flatMap((id) => {
          const names = content.namesById.get(id);
          return names ? [{ playerId: id, nameEn: names.nameEn, nameKa: names.nameKa }] : [];
        }),
      });
      outcome = resolved.outcome;
      playerId = resolved.playerId;
    }
    if (outcome === 'correct' && playerId && used.has(playerId)) outcome = 'already_used';
    if (outcome !== 'correct' || !playerId) return { outcome: outcome === 'correct' ? 'wrong' : outcome, player: null };
    const players = await getFootballGridBoardPlayers(input.boardId);
    const shown = (players.get(input.cellIndex) ?? []).find((player) => player.playerId === playerId);
    const names = content.namesById.get(playerId);
    return {
      outcome: 'correct',
      player: {
        playerId,
        name: shown?.name ?? names?.nameEn ?? '',
        nameKa: shown?.nameKa ?? names?.nameKa ?? null,
        imageUrl: shown?.imageUrl ?? null,
      },
    };
  },

  async options(input: {
    boardId: string;
    cellIndex: number;
    usedPlayerIds: readonly string[];
    optionSeed: string;
  }): Promise<FootballGridOption[] | null> {
    // Refuses a board that is not published, like judge().
    await boardContent(input.boardId);
    return buildFootballGridOptions({
      players: await getFootballGridBoardPlayers(input.boardId),
      cellIndex: input.cellIndex,
      usedPlayerIds: new Set(input.usedPlayerIds),
      seed: `${input.boardId}:${input.optionSeed}:${input.cellIndex}`,
    });
  },

  /**
   * The best-known answers of each cell. Not offered over HTTP for same-phone play (a board there is dealt from
   * the pool online matches use); the daily grid shows them for a day that has closed, whose board is its own.
   */
  async samples(boardId: string, perCell = 3): Promise<Array<{ cellIndex: number; players: FootballGridSoloPlayer[] }>> {
    await boardContent(boardId);
    const players = await getFootballGridBoardPlayers(boardId);
    return Array.from({ length: 9 }, (_, cellIndex) => ({
      cellIndex,
      players: (players.get(cellIndex) ?? []).slice(0, perCell).map((player) => ({
        playerId: player.playerId, name: player.name, nameKa: player.nameKa, imageUrl: player.imageUrl,
      })),
    }));
  },
};
