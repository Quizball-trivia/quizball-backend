import { createHmac, timingSafeEqual } from 'node:crypto';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import { AuthorizationError, ExternalServiceError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { resolveFootballGridAnswer } from './football-grid.answer-resolver.js';
import { loadFootballGridCarriedAnswers, type FootballGridCarriedAnswer } from './football-grid-carried-answers.js';
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
  FootballGridResolvedAnswer,
} from './football-grid.types.js';

const TICKET_TTL_MS = 6 * 60 * 60_000;
const CONTENT_CACHE_TTL_MS = 10 * 60_000;
const CONTENT_CACHE_MAX_ENTRIES = 256;

type SoloPlayerNames = { nameEn: string; nameKa: string | null; nameRu: string | null; imageUrl?: string | null };

export interface SoloBoardContent {
  aliases: FootballGridAliasRecord[];
  validPlayerIdsByCell: Map<number, string[]>;
  boardPlayerIds: string[];
  namesById: Map<string, SoloPlayerNames>;
  /** The carried answers could not be read: a refusal judged now might be a correction this content lacks. */
  incomplete?: true;
}

/**
 * The answers a board's cells accept: its own frozen list, plus what a published release now holds in both clues of
 * a cell (see loadFootballGridCarriedAnswers). Pure, so the merge is tested without a database.
 */
export function buildSoloBoardContent(input: {
  answers: Array<{ cellIndex: number; footballPlayerId: string; playerNameEn: string; playerNameKa: string | null; playerNameRu: string | null }>;
  aliasesByPlayer: ReadonlyMap<string, FootballGridAliasRecord[]>;
  carried?: readonly FootballGridCarriedAnswer[];
  carriedAliasesByRelease?: ReadonlyMap<string, ReadonlyMap<string, FootballGridAliasRecord[]>>;
}): SoloBoardContent {
  const validPlayerIdsByCell = new Map<number, string[]>();
  const namesById = new Map<string, SoloPlayerNames>();
  const add = (cellIndex: number, playerId: string) => {
    const cell = validPlayerIdsByCell.get(cellIndex) ?? [];
    if (!cell.includes(playerId)) cell.push(playerId);
    validPlayerIdsByCell.set(cellIndex, cell);
  };
  for (const answer of input.answers) {
    add(answer.cellIndex, answer.footballPlayerId);
    namesById.set(answer.footballPlayerId, { nameEn: answer.playerNameEn, nameKa: answer.playerNameKa, nameRu: answer.playerNameRu });
  }
  // A carried footballer is also read with the aliases of every release that holds him in a carried cell (a correction
  // can add an alias with the membership); one the board already holds keeps its names and its own aliases as well.
  const carriedReleases = new Map<string, Set<string>>();
  for (const answer of input.carried ?? []) {
    add(answer.cellIndex, answer.playerId);
    if (!namesById.has(answer.playerId)) {
      namesById.set(answer.playerId, { nameEn: answer.nameEn, nameKa: answer.nameKa, nameRu: answer.nameRu, imageUrl: answer.imageUrl });
    }
    const releases = carriedReleases.get(answer.playerId) ?? new Set<string>();
    releases.add(answer.releaseId);
    carriedReleases.set(answer.playerId, releases);
  }
  const boardPlayerIds = [...namesById.keys()];
  const aliasesOf = (playerId: string): FootballGridAliasRecord[] => {
    const all = [
      ...(input.aliasesByPlayer.get(playerId) ?? []),
      ...[...(carriedReleases.get(playerId) ?? [])].flatMap((release) => input.carriedAliasesByRelease?.get(release)?.get(playerId) ?? []),
    ];
    // The same alias from two releases under the same policy is one alias (the board's own copy, listed first, is
    // kept). Under different policies both stay: a correcting release that made an exact alias a safe typo target
    // must still forgive its typos, and the board's exact copy keeps judging as before.
    const seen = new Set<string>();
    return all.filter((alias) => {
      const key = `${alias.locale}:${alias.normalizedAlias}:${alias.acceptancePolicy}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    aliases: boardPlayerIds.flatMap(aliasesOf),
    validPlayerIdsByCell,
    boardPlayerIds,
    namesById,
  };
}

const contentCache = new Map<string, { expiresAt: number; value: Promise<SoloBoardContent> }>();

async function carriedAnswers(boardId: string): Promise<FootballGridCarriedAnswer[] | null> {
  try {
    return await loadFootballGridCarriedAnswers(boardId);
  } catch (error) {
    // The board's own answers still accept what they hold; a refusal is not judged until the lookup works again.
    logger.warn({ err: error, boardId }, 'Football Grid carried answers could not be loaded');
    return null;
  }
}

async function loadContent(boardId: string): Promise<SoloBoardContent> {
  const context = await footballGridRepo.getBoardAnswersByBoard(boardId);
  if (!context) throw new NotFoundError('Football Grid board not found');
  const [aliasesByPlayer, carried] = await Promise.all([getAliasesByPlayerForRelease(context.aliasReleaseId), carriedAnswers(boardId)]);
  if (!carried) return { ...buildSoloBoardContent({ answers: context.answers, aliasesByPlayer }), incomplete: true };
  const releases = [...new Set(carried.map((answer) => answer.releaseId))];
  const carriedAliasesByRelease = new Map(await Promise.all(releases.map(async (releaseId) =>
    [releaseId, releaseId === context.aliasReleaseId ? aliasesByPlayer : await getAliasesByPlayerForRelease(releaseId)] as const)));
  return buildSoloBoardContent({ answers: context.answers, aliasesByPlayer, carried, carriedAliasesByRelease });
}

/**
 * A refusal judged against content that lacks the carried answers might be a correction the board does not know yet:
 * it is not handed out (the daily grid would store it as a spent guess); the caller retries, nothing was spent.
 */
export function assertRefusalJudgeable(content: Pick<SoloBoardContent, 'incomplete'>): void {
  if (content.incomplete) throw new ExternalServiceError('Football Grid answers are temporarily unavailable; try again');
}

function boardContent(boardId: string): Promise<SoloBoardContent> {
  const now = Date.now();
  const cached = contentCache.get(boardId);
  if (cached && cached.expiresAt > now) return cached.value;
  const entry = { expiresAt: now + CONTENT_CACHE_TTL_MS, value: loadContent(boardId) };
  contentCache.set(boardId, entry);
  // A failed load, or one without the carried answers, is not kept: the next call reads again.
  entry.value.then(
    (content) => { if (content.incomplete && contentCache.get(boardId) === entry) contentCache.delete(boardId); },
    () => { if (contentCache.get(boardId) === entry) contentCache.delete(boardId); },
  );
  while (contentCache.size > CONTENT_CACHE_MAX_ENTRIES) {
    const oldest = contentCache.keys().next().value as string | undefined;
    if (!oldest) break;
    contentCache.delete(oldest);
  }
  return entry.value;
}

/** A typed name read against one cell of a board, with the board's own (and carried) aliases. */
export function resolveInCell(content: SoloBoardContent, cellIndex: number, text: string): FootballGridResolvedAnswer {
  const cellPlayerIds = content.validPlayerIdsByCell.get(cellIndex) ?? [];
  return resolveFootballGridAnswer({
    submittedText: text,
    aliases: content.aliases,
    validPlayerIds: cellPlayerIds,
    boardPlayerIds: content.boardPlayerIds,
    usedPlayerIds: [],
    validPlayerNames: cellPlayerIds.flatMap((id) => {
      const names = content.namesById.get(id);
      return names ? [{ playerId: id, nameEn: names.nameEn, nameKa: names.nameKa, nameRu: names.nameRu }] : [];
    }),
  });
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
  nameRu: string | null;
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
      const resolved = resolveInCell(content, input.cellIndex, input.text);
      outcome = resolved.outcome;
      playerId = resolved.playerId;
    }
    if (outcome === 'correct' && playerId && used.has(playerId)) outcome = 'already_used';
    if (outcome === 'wrong') assertRefusalJudgeable(content);
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
        nameRu: shown?.nameRu ?? names?.nameRu ?? null,
        imageUrl: shown?.imageUrl ?? names?.imageUrl ?? null,
      },
    };
  },

  /**
   * Server-side only, diagnostics for the content-gap log: how the matcher read a refused name in this cell. A second
   * (cached) lookup after judging, kept out of `judge` so nothing of it can ever ride along in a verdict a client sees;
   * a cache reload in between can label the observation with the newer revision.
   */
  async diagnose(input: { boardId: string; cellIndex: number; text: string }): Promise<{ reason: string; playerId: string | null; candidatePlayerIds: string[]; revision: string }> {
    const content = await boardContent(input.boardId);
    const resolved = resolveInCell(content, input.cellIndex, input.text);
    // The cell's answers include carried corrections: their revision, not just the board id, is what judged the name.
    const revision = revisionOf(content, (c: SoloBoardContent) => [[...c.validPlayerIdsByCell.entries()], c.aliases, [...c.namesById.entries()], c.incomplete ?? false]);
    return { reason: resolved.diagnostics.reason, playerId: resolved.playerId, candidatePlayerIds: resolved.diagnostics.candidatePlayerIds.slice(0, 10), revision };
  },

  /**
   * Server-side only (never sent to a client: it would say which footballers are on the board): what a refused name
   * was, for a "that was right" report. Null when the cell accepts the name after all, or it could be several.
   */
  async refusal(input: { boardId: string; cellIndex: number; text: string }): Promise<{ recognizedPlayerId: string | null } | null> {
    const resolved = resolveInCell(await boardContent(input.boardId), input.cellIndex, input.text);
    if (resolved.outcome !== 'wrong') return null;
    const { reason, candidateCount, candidatePlayerIds } = resolved.diagnostics;
    return { recognizedPlayerId: reason === 'recognized_not_in_cell' && candidateCount === 1 ? candidatePlayerIds[0] ?? null : null };
  },

  async options(input: {
    boardId: string;
    cellIndex: number;
    usedPlayerIds: readonly string[];
    optionSeed: string;
  }): Promise<FootballGridOption[] | null> {
    // Refuses a board that is not published, like judge().
    const content = await boardContent(input.boardId);
    const players = await getFootballGridBoardPlayers(input.boardId);
    // A carried answer (right for this cell, missing from the board's own list) is never offered as a wrong option:
    // judge() would accept it.
    const shown = new Set((players.get(input.cellIndex) ?? []).map((player) => player.playerId));
    const carried = (content.validPlayerIdsByCell.get(input.cellIndex) ?? []).filter((playerId) => !shown.has(playerId));
    return buildFootballGridOptions({
      players,
      cellIndex: input.cellIndex,
      usedPlayerIds: new Set([...input.usedPlayerIds, ...carried]),
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
        playerId: player.playerId, name: player.name, nameKa: player.nameKa, nameRu: player.nameRu, imageUrl: player.imageUrl,
      })),
    }));
  },
};
