import { createHash } from 'node:crypto';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql, type TransactionSql } from '../../db/index.js';
import {
  footballGridAddNames,
  footballGridNameUniverse,
  footballGridUniverseSnapshot,
  normalizeFootballGridAnswer,
  resolveFootballGridAnswer,
  type FootballGridNameIndex,
  type FootballGridNameUniverse,
  type FootballGridPlayerNameRecord,
} from './football-grid.answer-resolver.js';
import {
  footballGridEligibilityRepo,
  type FootballGridJudgeRollout,
  type FootballGridJudgeSurface,
} from './football-grid-eligibility.repo.js';
import type { FootballGridBoardPlayer, FootballGridBoardPlayers } from './football-grid-options.js';
import type { FootballGridAliasRecord, FootballGridResolvedAnswer } from './football-grid.types.js';

const ALIAS_PAGE = 20_000;
const NAMESAKE_PAGE = 20_000;
const VERSION_CACHE_MAX = 2;
const BOARD_CACHE_MAX = 512;
const ROLLOUT_CACHE_MS = 10_000;

/**
 * A judge version cannot be read right now (missing, revoked, still building, or a board it does not bind). Never
 * answered with another answer set: the caller retries, nothing is spent.
 */
export class FootballGridJudgeUnavailableError extends ExternalServiceError {
  constructor(reason: string) {
    super('Football Grid answers are temporarily unavailable; try again', { gridCode: 'GRID_JUDGE_UNAVAILABLE', reason });
  }
}

type PlayerNames = { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null };

interface VersionData {
  aliasesByPlayer: Map<string, FootballGridAliasRecord[]>;
  namesakes: FootballGridNameUniverse;
  /** The version-wide name universe, its alias index built once at load (not on a board's first answer). */
  universe: FootballGridNameUniverse;
}

/** One board judged under one version: the same shape every surface (online, bot, choice, solo, daily) reads. */
export interface FootballGridJudgedBoard {
  boardId: string;
  judgeVersionId: string;
  aliases: FootballGridAliasRecord[];
  validPlayerIdsByCell: Map<number, string[]>;
  boardPlayerIds: string[];
  playerNamesById: Map<string, PlayerNames>;
  boardPlayerNames: FootballGridPlayerNameRecord[];
  universe: FootballGridNameUniverse;
  /** Per cell, best known first: the choice-mode options and the bot read these. */
  boardPlayers: FootballGridBoardPlayers;
  /** Identifies exactly what judged an answer (shadow log, gap context). */
  checksum: string;
}

function lru<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Load once per key; a failed load is forgotten so the next caller tries again. */
function memo<V>(cache: Map<string, Promise<V>>, max: number, key: string, load: () => Promise<V>): Promise<V> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const value = load();
  cache.set(key, value);
  lru(cache, max);
  value.catch(() => { if (cache.get(key) === value) cache.delete(key); });
  return value;
}

const versionCache = new Map<string, Promise<VersionData>>();
/** The version the warmer keeps loaded: answers on older pinned versions never evict it (loaded or still loading). */
let keptVersionId: string | null = null;
/** While another version warms, the one kept before it stays cached too (a failed warm-up falls back to it, warm). */
let previousKeptVersionId: string | null = null;

function trimVersionCache(): void {
  for (const key of [...versionCache.keys()]) {
    if (versionCache.size <= VERSION_CACHE_MAX) break;
    if (key !== keptVersionId && key !== previousKeptVersionId) versionCache.delete(key);
  }
}

function versionData(versionId: string): Promise<VersionData> {
  const cached = versionCache.get(versionId);
  if (cached) {
    versionCache.delete(versionId);
    versionCache.set(versionId, cached);
    return cached;
  }
  const value = loadVersionData(versionId);
  versionCache.set(versionId, value);
  trimVersionCache();
  value.catch(() => { if (versionCache.get(versionId) === value) versionCache.delete(versionId); });
  return value;
}
const boardCache = new Map<string, Promise<FootballGridJudgedBoard>>();

async function loadVersionData(versionId: string): Promise<VersionData> {
  const aliasesByPlayer = new Map<string, FootballGridAliasRecord[]>();
  for (let after: string | null = null; ;) {
    const page = await footballGridEligibilityRepo.getAliasesPage(versionId, after, ALIAS_PAGE);
    for (const alias of page) {
      const list = aliasesByPlayer.get(alias.playerId);
      if (list) list.push(alias);
      else aliasesByPlayer.set(alias.playerId, [alias]);
    }
    if (page.length < ALIAS_PAGE) break;
    after = page[page.length - 1].id;
  }
  const index: FootballGridNameIndex = new Map();
  for (let after: { playerId: string; name: string } | null = null; ;) {
    const page = await footballGridEligibilityRepo.getNamesakesPage(versionId, after, NAMESAKE_PAGE);
    footballGridAddNames(index, page);
    if (page.length < NAMESAKE_PAGE) break;
    const last = page[page.length - 1];
    after = { playerId: last.playerId, name: last.normalized };
  }
  // Fully loaded before any verdict: unlike the live index there is no "still loading" window that switches typos off.
  const namesakes: FootballGridNameUniverse = { holders: (key) => index.get(key) ?? [], pending: () => false };
  // Building it indexes every alias of the version: done here, in the (background) load, not on a first answer.
  const universe = footballGridNameUniverse([aliasesByPlayer], namesakes);
  logger.info({ versionId, aliasPlayers: aliasesByPlayer.size, names: index.size }, 'Football Grid judge version loaded');
  return { aliasesByPlayer, namesakes, universe };
}

async function assertServable(versionId: string): Promise<void> {
  const status = await footballGridEligibilityRepo.getVersionStatus(versionId);
  if (status !== 'ready' && status !== 'active') throw new FootballGridJudgeUnavailableError(`version ${status ?? 'missing'}`);
}

async function loadJudgedBoard(boardId: string, versionId: string): Promise<FootballGridJudgedBoard> {
  // Only a board the version certified (every cell answerable): bound criteria with empty cells never judge.
  if (!await footballGridEligibilityRepo.isBoardCertified(boardId, versionId)) {
    throw new FootballGridJudgeUnavailableError('board not certified by version');
  }
  const bindings = await footballGridEligibilityRepo.getBoardBindings(boardId, versionId);
  if (!bindings || [...bindings.rows, ...bindings.columns].some((definition) => definition === null)) {
    throw new FootballGridJudgeUnavailableError('board criteria not bound by version');
  }
  const [data, rows] = await Promise.all([
    versionData(versionId),
    footballGridEligibilityRepo.getBoardCells(boardId, versionId, bindings.rows as string[], bindings.columns as string[]),
  ]);
  const validPlayerIdsByCell = new Map<number, string[]>();
  const playerNamesById = new Map<string, PlayerNames>();
  const boardPlayers = new Map<number, FootballGridBoardPlayer[]>();
  for (const row of rows) {
    const cell = validPlayerIdsByCell.get(row.cellIndex) ?? [];
    cell.push(row.playerId);
    validPlayerIdsByCell.set(row.cellIndex, cell);
    playerNamesById.set(row.playerId, { nameEn: row.nameEn, nameKa: row.nameKa, nameRu: row.nameRu, nameEl: row.nameEl });
    const shown = boardPlayers.get(row.cellIndex) ?? [];
    shown.push({ cellIndex: row.cellIndex, playerId: row.playerId, name: row.nameEn, nameKa: row.nameKa, nameRu: row.nameRu, nameEl: row.nameEl, imageUrl: row.imageUrl });
    boardPlayers.set(row.cellIndex, shown);
  }
  const boardPlayerIds = [...playerNamesById.keys()];
  const checksum = createHash('sha256')
    .update(JSON.stringify([versionId, boardId, [...validPlayerIdsByCell.entries()].sort((a, b) => a[0] - b[0])]))
    .digest('hex').slice(0, 32);
  return {
    boardId,
    judgeVersionId: versionId,
    aliases: boardPlayerIds.flatMap((playerId) => data.aliasesByPlayer.get(playerId) ?? []),
    validPlayerIdsByCell,
    boardPlayerIds,
    playerNamesById,
    boardPlayerNames: [...playerNamesById].map(([playerId, names]) => ({ playerId, ...names })),
    universe: data.universe,
    boardPlayers,
    checksum,
  };
}

/** A picked option names its footballer outright, so there is nothing to resolve: it is in the cell or it is not. */
export function resolvePickedOption(
  playerId: string,
  cellPlayerIds: readonly string[],
  submittedText: string,
): FootballGridResolvedAnswer {
  const correct = cellPlayerIds.includes(playerId);
  return {
    outcome: correct ? 'correct' : 'wrong',
    playerId: correct ? playerId : null,
    aliasId: null,
    normalizedInput: normalizeFootballGridAnswer(submittedText),
    diagnostics: {
      version: 1,
      reason: correct ? 'accepted' : 'recognized_not_in_cell',
      method: 'exact',
      candidatePlayerIds: [playerId],
      candidateCount: 1,
      candidatesTruncated: false,
      cellCandidateCount: correct ? 1 : 0,
    },
  };
}

/**
 * One answer judged against one board content, the way every match reads it: used footballers are consulted only
 * for an otherwise-correct answer (wrong and ambiguous never turn correct), and a typed name is then read again with
 * them (a name several right answers share is only credited while none of them is used).
 */
export async function footballGridJudgeAnswer(
  content: Pick<FootballGridJudgedBoard, 'aliases' | 'validPlayerIdsByCell' | 'boardPlayerIds' | 'playerNamesById' | 'boardPlayerNames' | 'universe'>,
  cellIndex: number,
  submittedText: string,
  pickedPlayerId: string | null,
  usedPlayerIds: () => Promise<string[]>,
): Promise<FootballGridResolvedAnswer> {
  const cellPlayerIds = content.validPlayerIdsByCell.get(cellIndex) ?? [];
  const universe = footballGridUniverseSnapshot(content.universe);
  const resolveTyped = (used: readonly string[]) => resolveFootballGridAnswer({
    submittedText,
    aliases: content.aliases,
    validPlayerIds: cellPlayerIds,
    boardPlayerIds: content.boardPlayerIds,
    usedPlayerIds: used,
    validPlayerNames: cellPlayerIds.flatMap((playerId) => {
      const names = content.playerNamesById.get(playerId);
      return names ? [{ playerId, nameEn: names.nameEn, nameKa: names.nameKa, nameRu: names.nameRu, nameEl: names.nameEl }] : [];
    }),
    boardPlayerNames: content.boardPlayerNames,
    universe,
  });
  let resolution = pickedPlayerId ? resolvePickedOption(pickedPlayerId, cellPlayerIds, submittedText) : resolveTyped([]);
  if (resolution.outcome === 'correct' && resolution.playerId) {
    const used = await usedPlayerIds();
    if (!pickedPlayerId && used.length > 0) {
      resolution = resolveTyped(used);
    } else if (used.includes(resolution.playerId)) {
      resolution = { ...resolution, outcome: 'already_used',
        diagnostics: { ...resolution.diagnostics, reason: 'player_already_used' } };
    }
  }
  return resolution;
}

let rolloutCache: { value: Promise<FootballGridJudgeRollout>; expiresAt: number } | null = null;

/** Deterministic cohort: the same key always lands on the same side of a percentage. */
export function footballGridJudgeCohort(key: string): number {
  return createHash('sha256').update(`football-grid-judge:${key}`).digest().readUInt32BE(0) % 100;
}

export const footballGridJudge = {
  /** Shared by every match, run and replica reading the same (board, version): built once per process. */
  async getJudgedBoard(boardId: string, versionId: string): Promise<FootballGridJudgedBoard> {
    // Every call, warm cache or not: a revoked version stops judging at once on every surface.
    await assertServable(versionId);
    return memo(boardCache, BOARD_CACHE_MAX, `${boardId}:${versionId}`, () => loadJudgedBoard(boardId, versionId));
  },

  /**
   * The version a new match or run gets: the active one, when it certified the board and the cohort is in the
   * surface's rollout. Read in the creating transaction, so both replicas decide from the same committed row.
   */
  async pinForNew(executor: TransactionSql | undefined, input: { boardId: string; surface: FootballGridJudgeSurface; cohortKey: string; requireChoice?: boolean }): Promise<string | null> {
    const run = executor ?? sql;
    const rollout = await footballGridEligibilityRepo.getRollout(run);
    if (footballGridJudgeCohort(input.cohortKey) >= rollout[input.surface]) return null;
    return footballGridEligibilityRepo.getActiveVersionForBoard(run, input.boardId, input.requireChoice ?? false);
  },

  /** Shadow sampling only (never pins): a short cache keeps the rollout read off every answer. */
  async shadowRollout(): Promise<FootballGridJudgeRollout> {
    const now = Date.now();
    if (!rolloutCache || rolloutCache.expiresAt <= now) {
      const value = footballGridEligibilityRepo.getRollout();
      rolloutCache = { value, expiresAt: now + ROLLOUT_CACHE_MS };
      value.catch(() => { if (rolloutCache?.value === value) rolloutCache = null; });
    }
    return rolloutCache.value;
  },

  resolveTyped(board: FootballGridJudgedBoard, cellIndex: number, text: string, usedPlayerIds: readonly string[]): FootballGridResolvedAnswer {
    const cellPlayerIds = board.validPlayerIdsByCell.get(cellIndex) ?? [];
    return resolveFootballGridAnswer({
      submittedText: text,
      aliases: board.aliases,
      validPlayerIds: cellPlayerIds,
      boardPlayerIds: board.boardPlayerIds,
      usedPlayerIds,
      validPlayerNames: cellPlayerIds.flatMap((playerId) => {
        const names = board.playerNamesById.get(playerId);
        return names ? [{ playerId, ...names }] : [];
      }),
      boardPlayerNames: board.boardPlayerNames,
      universe: board.universe,
    });
  },

  assertServable,

  /**
   * Loads a version's shared data (aliases and the typo-veto names: the slow part of a first answer) into this
   * process's cache. An answer that arrives meanwhile awaits the same load instead of starting another.
   */
  async warmVersion(versionId: string): Promise<void> {
    const previous = keptVersionId;
    if (previous !== versionId) previousKeptVersionId = previous;
    keptVersionId = versionId;
    try {
      await versionData(versionId);
    } catch (error) {
      // A version that could not load must not displace the one kept before it (a rollback to it keeps it pinned).
      if (keptVersionId === versionId) keptVersionId = previous;
      throw error;
    } finally {
      if (previousKeptVersionId === previous) previousKeptVersionId = null;
      trimVersionCache();
    }
  },

  /** True while the version's shared data is cached and kept (never evicted); otherwise the warmer warms it again. */
  isVersionLoaded(versionId: string): boolean {
    return keptVersionId === versionId && versionCache.has(versionId);
  },

  /** Tests and tools: forget everything this process loaded. */
  resetCaches(): void {
    versionCache.clear();
    boardCache.clear();
    keptVersionId = null;
    previousKeptVersionId = null;
    rolloutCache = null;
  },
};

export const JUDGE_WARM_POLL_MS = 30_000;

/**
 * Keeps the active judge version loaded on this replica, so the first answer after a deploy or an activation does not
 * pay the load. Polls the active version id (one primary-key read; every replica sees the same committed row) and
 * loads a version the first time it is active. Never blocks start-up or health checks, never throws: until a load
 * lands, answers take the ordinary cold path, which waits on the same load.
 */
export function createFootballGridJudgeWarmer(deps: {
  getActiveVersion: () => Promise<string | null>;
  warmVersion: (versionId: string) => Promise<void>;
  /** Whether the version is still cached: answers on older pinned versions can evict it, and then it is warmed again. */
  isLoaded?: (versionId: string) => boolean;
  intervalMs?: number;
  log?: { info: (meta: object, message: string) => void; warn: (meta: object, message: string) => void };
  now?: () => number;
}) {
  let warmed: string | null = null;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const now = deps.now ?? (() => performance.now());

  async function tick(): Promise<void> {
    const versionId = await deps.getActiveVersion();
    if (!versionId || (versionId === warmed && (deps.isLoaded?.(versionId) ?? true))) return;
    const started = now();
    await deps.warmVersion(versionId);
    warmed = versionId;
    deps.log?.info({ versionId, ms: Math.round(now() - started) }, 'Football Grid judge version warmed');
  }

  return {
    /** One check; overlapping calls share it. Resolves either way: a failure is logged and retried on the next poll. */
    check(): Promise<void> {
      if (!running) {
        running = tick()
          .catch((error: unknown) => deps.log?.warn({ err: error }, 'Football Grid judge version could not be warmed'))
          .finally(() => { running = null; });
      }
      return running;
    },
    start(): void {
      if (timer) return;
      void this.check();
      timer = setInterval(() => { void this.check(); }, deps.intervalMs ?? JUDGE_WARM_POLL_MS);
      timer.unref();
    },
    /** Stops polling; resolves once a load in progress has settled (shutdown drains it before the pool closes). */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
    warmedVersion: () => warmed,
  };
}

/** The process's warmer (started in main.ts, after the server listens). */
export const footballGridJudgeWarmer = createFootballGridJudgeWarmer({
  getActiveVersion: () => footballGridEligibilityRepo.getActiveVersion(),
  warmVersion: (versionId) => footballGridJudge.warmVersion(versionId),
  isLoaded: (versionId) => footballGridJudge.isVersionLoaded(versionId),
  log: logger,
});
