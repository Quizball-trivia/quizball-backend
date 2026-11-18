import { createHmac, timingSafeEqual } from 'node:crypto';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import { AuthorizationError, ExternalServiceError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  footballGridNameUniverse,
  resolveFootballGridAnswer,
  type FootballGridNameUniverse,
  type FootballGridPlayerNameRecord,
} from './football-grid.answer-resolver.js';
import { footballGridNamesakes } from './football-grid-namesakes.js';
import { loadFootballGridCarriedAnswers, type FootballGridCarriedAnswer } from './football-grid-carried-answers.js';
import {
  buildFootballGridOptions,
  footballGridSecret,
  getFootballGridBoardPlayers,
  type FootballGridBoardPlayers,
  type FootballGridOption,
} from './football-grid-options.js';
import { footballGridRepo } from './football-grid.repo.js';
import { footballGridJudge, type FootballGridJudgedBoard } from './football-grid-judge.service.js';
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

type SoloPlayerNames = { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null; imageUrl?: string | null };

export interface SoloBoardContent {
  aliases: FootballGridAliasRecord[];
  validPlayerIdsByCell: Map<number, string[]>;
  boardPlayerIds: string[];
  namesById: Map<string, SoloPlayerNames>;
  boardPlayerNames: FootballGridPlayerNameRecord[];
  /** Every footballer of the board's release and of the releases its carried answers come from (the typo veto). */
  universe: FootballGridNameUniverse;
  /** The carried answers could not be read: a refusal judged now might be a correction this content lacks. */
  incomplete?: true;
  /** Versioned content: the cells and their best-known order come from the shared judge version. */
  boardPlayers?: FootballGridBoardPlayers;
  revision?: string;
}

/** The shared judge's board in the shape solo and daily read; nothing is carried, the version is the whole truth. */
export function soloContentFromJudgedBoard(board: FootballGridJudgedBoard): SoloBoardContent {
  const images = new Map<string, string | null>();
  for (const players of board.boardPlayers.values()) for (const player of players) images.set(player.playerId, player.imageUrl);
  return {
    aliases: board.aliases,
    validPlayerIdsByCell: board.validPlayerIdsByCell,
    boardPlayerIds: board.boardPlayerIds,
    namesById: new Map([...board.playerNamesById].map(([playerId, names]) => [playerId, { ...names, imageUrl: images.get(playerId) ?? null }])),
    boardPlayerNames: board.boardPlayerNames,
    universe: board.universe,
    boardPlayers: board.boardPlayers,
    revision: board.checksum,
  };
}

/**
 * The answers a board's cells accept: its own frozen list, plus what a published release now holds in both clues of
 * a cell (see loadFootballGridCarriedAnswers). Pure, so the merge is tested without a database.
 */
export function buildSoloBoardContent(input: {
  answers: Array<{ cellIndex: number; footballPlayerId: string; playerNameEn: string; playerNameKa: string | null; playerNameRu: string | null; playerNameEl: string | null }>;
  aliasesByPlayer: ReadonlyMap<string, FootballGridAliasRecord[]>;
  carried?: readonly FootballGridCarriedAnswer[];
  carriedAliasesByRelease?: ReadonlyMap<string, ReadonlyMap<string, FootballGridAliasRecord[]>>;
  /** Footballers beyond these releases, for the typo veto (football-grid-namesakes.ts). */
  namesakes?: FootballGridNameUniverse;
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
    namesById.set(answer.footballPlayerId, { nameEn: answer.playerNameEn, nameKa: answer.playerNameKa, nameRu: answer.playerNameRu, nameEl: answer.playerNameEl });
  }
  // A carried footballer is also read with the aliases of every release that holds him in a carried cell (a correction
  // can add an alias with the membership); one the board already holds keeps its names and its own aliases as well.
  const carriedReleases = new Map<string, Set<string>>();
  for (const answer of input.carried ?? []) {
    add(answer.cellIndex, answer.playerId);
    const held = namesById.get(answer.playerId);
    if (!held) {
      namesById.set(answer.playerId, { nameEn: answer.nameEn, nameKa: answer.nameKa, nameRu: answer.nameRu, nameEl: answer.nameEl, imageUrl: answer.imageUrl });
    } else {
      // The board keeps its names; a name only the carried release has (its release added it later) fills a gap.
      namesById.set(answer.playerId, { ...held, nameKa: held.nameKa ?? answer.nameKa, nameRu: held.nameRu ?? answer.nameRu, nameEl: held.nameEl ?? answer.nameEl });
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
    boardPlayerNames: [...namesById].map(([playerId, names]) => ({ playerId, nameEn: names.nameEn, nameKa: names.nameKa, nameRu: names.nameRu, nameEl: names.nameEl })),
    universe: footballGridNameUniverse([
      input.aliasesByPlayer,
      ...[...new Set([...carriedReleases.values()].flatMap((releases) => [...releases]))]
        .flatMap((release) => input.carriedAliasesByRelease?.get(release) ?? []),
    ], input.namesakes),
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
  if (!carried) return { ...buildSoloBoardContent({ answers: context.answers, aliasesByPlayer, namesakes: footballGridNamesakes }), incomplete: true };
  const releases = [...new Set(carried.map((answer) => answer.releaseId))];
  const carriedAliasesByRelease = new Map(await Promise.all(releases.map(async (releaseId) =>
    [releaseId, releaseId === context.aliasReleaseId ? aliasesByPlayer : await getAliasesByPlayerForRelease(releaseId)] as const)));
  return buildSoloBoardContent({ answers: context.answers, aliasesByPlayer, carried, carriedAliasesByRelease, namesakes: footballGridNamesakes });
}

/**
 * A refusal judged against content that lacks the carried answers might be a correction the board does not know yet:
 * it is not handed out (the daily grid would store it as a spent guess); the caller retries, nothing was spent.
 */
export function assertRefusalJudgeable(content: Pick<SoloBoardContent, 'incomplete'>): void {
  if (content.incomplete) throw new ExternalServiceError('Football Grid answers are temporarily unavailable; try again');
}

/** A pinned version reads the shared judge (a version it cannot read refuses, never falls back); otherwise the board. */
async function contentFor(boardId: string, judgeVersionId: string | null | undefined): Promise<SoloBoardContent> {
  if (judgeVersionId) return soloContentFromJudgedBoard(await footballGridJudge.getJudgedBoard(boardId, judgeVersionId));
  return boardContent(boardId);
}

async function playersFor(boardId: string, content: SoloBoardContent): Promise<FootballGridBoardPlayers> {
  return content.boardPlayers ?? getFootballGridBoardPlayers(boardId);
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
export function resolveInCell(
  content: SoloBoardContent,
  cellIndex: number,
  text: string,
  usedPlayerIds: readonly string[] = [],
): FootballGridResolvedAnswer {
  const cellPlayerIds = content.validPlayerIdsByCell.get(cellIndex) ?? [];
  return resolveFootballGridAnswer({
    submittedText: text,
    aliases: content.aliases,
    validPlayerIds: cellPlayerIds,
    boardPlayerIds: content.boardPlayerIds,
    usedPlayerIds,
    boardPlayerNames: content.boardPlayerNames,
    universe: content.universe,
    validPlayerNames: cellPlayerIds.flatMap((id) => {
      const names = content.namesById.get(id);
      return names ? [{ playerId: id, nameEn: names.nameEn, nameKa: names.nameKa, nameRu: names.nameRu, nameEl: names.nameEl }] : [];
    }),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ticketSignature(boardId: string, expiresAtMs: number, judgeVersionId: string | null | undefined): Buffer {
  // undefined: a ticket from before versions (two parts), signed over the board and expiry only.
  const pinned = judgeVersionId === undefined ? '' : `:${judgeVersionId ?? '-'}`;
  return createHmac('sha256', footballGridSecret()).update(`football-grid-solo:${boardId}:${expiresAtMs}${pinned}`).digest();
}

/**
 * Proof that this server dealt the board to the caller. Board ids are visible to both players of an online
 * match, so without it anyone could ask these endpoints about the board they are playing for rating. It also
 * carries the judge version the game pinned when it was dealt, so every answer of the game is judged by it.
 */
export function signFootballGridSoloTicket(boardId: string, nowMs: number, judgeVersionId: string | null = null): string {
  const expiresAtMs = nowMs + TICKET_TTL_MS;
  return `${expiresAtMs}.${judgeVersionId ?? '-'}.${ticketSignature(boardId, expiresAtMs, judgeVersionId).toString('hex')}`;
}

/** The judge version the ticket pinned (null: the board's own answers). Throws for a ticket this server did not sign. */
export function assertFootballGridSoloTicket(boardId: string, ticket: string, nowMs: number): { judgeVersionId: string | null } {
  const parts = ticket.split('.');
  const [expires, pinned, signature] = parts.length === 3 ? parts : [parts[0], undefined, parts[1]];
  const judgeVersionId = pinned === undefined ? undefined : pinned === '-' ? null : UUID.test(pinned) ? pinned : 'invalid';
  const expiresAtMs = Number(expires);
  const given = Buffer.from(signature ?? '', 'hex');
  const expected = Number.isSafeInteger(expiresAtMs) && judgeVersionId !== 'invalid' && parts.length <= 3
    ? ticketSignature(boardId, expiresAtMs, judgeVersionId) : null;
  if (!expected || expiresAtMs < nowMs || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AuthorizationError('This board was not dealt to you, or the game has expired');
  }
  return { judgeVersionId: judgeVersionId ?? null };
}

export interface FootballGridSoloPlayer {
  playerId: string;
  name: string;
  nameKa: string | null;
  nameRu: string | null;
  nameEl: string | null;
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
    /** The version the game pinned; absent or null: the board's own answers. */
    judgeVersionId?: string | null;
  }): Promise<FootballGridSoloVerdict> {
    const content = await contentFor(input.boardId, input.judgeVersionId);
    const cellPlayerIds = content.validPlayerIdsByCell.get(input.cellIndex) ?? [];
    const used = new Set(input.usedPlayerIds);
    let playerId: string | null = null;
    let outcome: FootballGridSoloVerdict['outcome'];
    if (input.optionPlayerId) {
      outcome = cellPlayerIds.includes(input.optionPlayerId) ? 'correct' : 'wrong';
      playerId = input.optionPlayerId;
    } else {
      const resolved = resolveInCell(content, input.cellIndex, input.text, input.usedPlayerIds);
      outcome = resolved.outcome;
      playerId = resolved.playerId;
    }
    if (outcome === 'correct' && playerId && used.has(playerId)) outcome = 'already_used';
    if (outcome === 'wrong') assertRefusalJudgeable(content);
    if (outcome !== 'correct' || !playerId) return { outcome: outcome === 'correct' ? 'wrong' : outcome, player: null };
    const players = await playersFor(input.boardId, content);
    const shown = (players.get(input.cellIndex) ?? []).find((player) => player.playerId === playerId);
    const names = content.namesById.get(playerId);
    return {
      outcome: 'correct',
      player: {
        playerId,
        name: shown?.name ?? names?.nameEn ?? '',
        nameKa: shown?.nameKa ?? names?.nameKa ?? null,
        nameRu: shown?.nameRu ?? names?.nameRu ?? null,
        nameEl: shown?.nameEl ?? names?.nameEl ?? null,
        imageUrl: shown?.imageUrl ?? names?.imageUrl ?? null,
      },
    };
  },

  /**
   * Server-side only, diagnostics for the content-gap log: how the matcher read a refused name in this cell. A second
   * (cached) lookup after judging, kept out of `judge` so nothing of it can ever ride along in a verdict a client sees;
   * a cache reload in between can label the observation with the newer revision.
   */
  async diagnose(input: { boardId: string; cellIndex: number; text: string; usedPlayerIds?: readonly string[]; judgeVersionId?: string | null }): Promise<{ reason: string; playerId: string | null; candidatePlayerIds: string[]; revision: string }> {
    const content = await contentFor(input.boardId, input.judgeVersionId);
    // Read with the run's used footballers, as judge() was: a shared name is ambiguous only once one of them is used.
    const resolved = resolveInCell(content, input.cellIndex, input.text, input.usedPlayerIds);
    // The cell's answers include carried corrections: their revision, not just the board id, is what judged the name.
    const revision = content.revision ?? revisionOf(content, (c: SoloBoardContent) => [[...c.validPlayerIdsByCell.entries()], c.aliases, [...c.namesById.entries()], c.incomplete ?? false]);
    return { reason: resolved.diagnostics.reason, playerId: resolved.playerId, candidatePlayerIds: resolved.diagnostics.candidatePlayerIds.slice(0, 10), revision };
  },

  /**
   * Server-side only (never sent to a client: it would say which footballers are on the board): what a refused name
   * was, for a "that was right" report. Null when the cell accepts the name after all, or it could be several.
   */
  async refusal(input: { boardId: string; cellIndex: number; text: string; judgeVersionId?: string | null }): Promise<{ recognizedPlayerId: string | null } | null> {
    const resolved = resolveInCell(await contentFor(input.boardId, input.judgeVersionId), input.cellIndex, input.text);
    if (resolved.outcome !== 'wrong') return null;
    const { reason, candidateCount, candidatePlayerIds } = resolved.diagnostics;
    return { recognizedPlayerId: reason === 'recognized_not_in_cell' && candidateCount === 1 ? candidatePlayerIds[0] ?? null : null };
  },

  async options(input: {
    boardId: string;
    cellIndex: number;
    usedPlayerIds: readonly string[];
    optionSeed: string;
    judgeVersionId?: string | null;
  }): Promise<FootballGridOption[] | null> {
    // Refuses a board that is not published, like judge().
    const content = await contentFor(input.boardId, input.judgeVersionId);
    const players = await playersFor(input.boardId, content);
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
        playerId: player.playerId, name: player.name, nameKa: player.nameKa, nameRu: player.nameRu, nameEl: player.nameEl, imageUrl: player.imageUrl,
      })),
    }));
  },
};
