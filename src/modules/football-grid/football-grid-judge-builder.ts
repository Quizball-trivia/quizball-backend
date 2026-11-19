import { createHash } from 'node:crypto';
import { normalizeFootballGridAnswer } from './football-grid.answer-resolver.js';
import { validateFootballGridBoard } from './football-grid.content-validator.js';
import { buildFootballGridOptions, type FootballGridBoardPlayer } from './football-grid-options.js';
import type { FootballGridBoardCandidate } from './football-grid.types.js';

/**
 * The decisions behind a judge version, kept pure so they are tested without a database: which release criterion
 * means which shared definition, where a curated fact lands, and whether a board is playable under the version.
 * scripts/football-grid-judge-build.ts does the reading and writing.
 */

/** Members a criterion must share with the newest release's row of its key to be read as the same criterion. */
export const BINDING_MIN_OVERLAP = 0.8;
export const SEMANTIC_VERSION = 1;

export interface CriterionRow {
  id: string;
  key: string;
  family: string;
  subtype: string;
  labelEn: string;
  releaseVersion: number;
  /** |members ∩ newest row's members| / min(|members|, |newest|); 1 for the newest row itself. */
  overlap: number;
}

export interface BindingOverride {
  criterionKey: string;
  decision: 'bind' | 'ambiguous';
  reviewer: string;
  note?: string;
}

export interface BindingDecision {
  criterionId: string;
  definitionKey: string | null;
  status: 'bound' | 'ambiguous';
  reason: string;
}

export interface DefinitionSpec {
  definitionKey: string;
  family: string;
  subtype: string;
  entityRef: string;
  semanticVersion: number;
  predicate: string;
}

export function definitionSpec(family: string, subtype: string, entityRef: string, predicate = subtype): DefinitionSpec {
  return {
    definitionKey: `${family}|${subtype}|${entityRef}|v${SEMANTIC_VERSION}`,
    family, subtype, entityRef, semanticVersion: SEMANTIC_VERSION, predicate,
  };
}

/**
 * The label as far as meaning goes. Teammate labels were reworded from "Played with X" to "Club teammate of X" with
 * the same same-club-season predicate (tests/football-grid/football-grid-teammate-relabel.test.ts): the wording is
 * not a re-scope. Any other change of label is.
 */
export function semanticLabel(family: string, label: string): string {
  const plain = label.trim().replace(/\s+/g, ' ').toLowerCase();
  if (family !== 'teammate') return plain;
  return plain.replace(/^(club teammate of|played with) /, '');
}

/**
 * Binds every release criterion to a definition only when the key, family, subtype and meaning agree across releases
 * and its members agree with the newest row; anything else is ambiguous and its boards stay on their own answers.
 * A reviewed override wins.
 */
export function decideBindings(rows: readonly CriterionRow[], overrides: readonly BindingOverride[] = []): { decisions: BindingDecision[]; definitions: DefinitionSpec[] } {
  const byKey = new Map<string, CriterionRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  const overrideByKey = new Map(overrides.map((override) => [override.criterionKey, override]));
  const decisions: BindingDecision[] = [];
  const definitions = new Map<string, DefinitionSpec>();
  for (const [key, keyRows] of byKey) {
    const shapes = new Set(keyRows.map((row) => `${row.family}|${row.subtype}`));
    const labels = new Set(keyRows.map((row) => semanticLabel(row.family, row.labelEn)));
    const override = overrideByKey.get(key);
    const spec = shapes.size === 1 ? definitionSpec(keyRows[0].family, keyRows[0].subtype, key) : null;
    for (const row of keyRows) {
      let reason: string | null = null;
      if (!spec) reason = 'family/subtype differ across releases';
      else if (labels.size > 1) reason = 'label differs across releases';
      else if (row.overlap < BINDING_MIN_OVERLAP) reason = `members overlap ${row.overlap.toFixed(2)} with newest release`;
      if (override) {
        if (override.decision === 'ambiguous') reason = `reviewed ambiguous by ${override.reviewer}`;
        else if (spec) reason = null;
      }
      if (reason || !spec) {
        decisions.push({ criterionId: row.id, definitionKey: null, status: 'ambiguous', reason: reason ?? 'no definition' });
      } else {
        definitions.set(spec.definitionKey, spec);
        decisions.push({
          criterionId: row.id, definitionKey: spec.definitionKey, status: 'bound',
          reason: override?.decision === 'bind' ? `reviewed bind by ${override.reviewer}` : 'auto: key+family+subtype+label+members',
        });
      }
    }
  }
  return { decisions, definitions: [...definitions.values()] };
}

/** One curated assertion of the fact file (facts-seed format). */
export interface FactRecord {
  player_id: string;
  criterion_key: string;
  family: string;
  origin?: string;
  op?: 'assert' | 'retract';
  evidence?: Array<{ source?: string; detail?: string | null }>;
}

export function factId(fact: Pick<FactRecord, 'player_id' | 'criterion_key'>): string {
  return createHash('sha256').update(`${fact.player_id}|${fact.criterion_key}`).digest('hex').slice(0, 24);
}

/**
 * A trophy criterion on today's boards means an appearance in the winning campaign. A curated trophy fact counts for
 * it only when its evidence shows that (an appearance record, or a report checked against the appearance rule);
 * otherwise it is a different predicate (in the squad that season) and lands on its own definition, which no current
 * board uses.
 */
export function trophyFactMeetsAppearanceRule(fact: FactRecord, appearanceOrigins: ReadonlySet<string> = new Set()): boolean {
  // Origins the fact file's curator checked against the appearance rule (passed by the builder's caller).
  if (fact.origin && appearanceOrigins.has(fact.origin)) return true;
  const eu = (fact.evidence ?? []).filter((item) => item.source === 'EU').map((item) => item.detail ?? '');
  // Conflicting evidence never routes to the appearance rule: one stated absence anywhere outweighs any positive item.
  if (eu.some(evidenceStatesAbsence)) return false;
  return eu.some(evidenceShowsAppearance);
}

/** "no appearances", "0 Vesper Cup apps", "unused substitute", "did not play": a stated absence of an appearance. */
export function evidenceStatesAbsence(detail: string): boolean {
  return /\b(?:no|zero|0)\s+(?:[\w.'-]+\s+){0,4}?app(?:earance)?s?\b|\bunused\s+sub(?:stitute)?\b|\bdid\s+not\s+(?:play|appear)\b/i.test(detail);
}

/** A recorded appearance, stated positively ("made a recorded competition appearance", "3 FA Cup apps"); a stated
 *  absence ("no appearances", "unused substitute", "0 apps") never counts, whatever else the text says. */
export function evidenceShowsAppearance(detail: string): boolean {
  if (evidenceStatesAbsence(detail)) return false;
  return /\bmade\s+(?:a|an|\d+)\s+recorded\s+(?:competition\s+|senior\s+)?appearances?\b|\b[1-9]\d*\s+(?:[A-Z][\w.-]*\s+){0,3}app(?:earance)?s?\b/.test(detail);
}

export type FactRouting =
  | { kind: 'definition'; definitionKey: string }
  | { kind: 'squad-rule'; definition: DefinitionSpec }
  | { kind: 'unknown-criterion' };

export function routeFact(
  fact: FactRecord,
  definitionKeyByCriterionKey: ReadonlyMap<string, string>,
  appearanceOrigins: ReadonlySet<string> = new Set(),
): FactRouting {
  const definitionKey = definitionKeyByCriterionKey.get(fact.criterion_key);
  if (!definitionKey) return { kind: 'unknown-criterion' };
  if (fact.family === 'trophy_award' && !trophyFactMeetsAppearanceRule(fact, appearanceOrigins)) {
    return { kind: 'squad-rule', definition: definitionSpec('trophy_award', 'winning-squad', fact.criterion_key, 'in-winning-squad-that-season') };
  }
  return { kind: 'definition', definitionKey };
}

export function normalizedAliasOf(alias: string): string {
  return normalizeFootballGridAnswer(alias);
}

export interface CertificationInput {
  boardId: string;
  theme: string;
  checksum: string;
  rows: Array<{ id: string; key: string; difficulty: 'easy' | 'normal' | 'hard' }>;
  columns: Array<{ id: string; key: string; difficulty: 'easy' | 'normal' | 'hard' }>;
  /** Per cell, best known first. */
  cells: string[][];
  /** Per cell, the footballers the board marks recognizable. */
  recognizable: string[][];
  names: ReadonlyMap<string, { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null }>;
}

/** A board's published hint for one of a cell's footballers: a sample, or a recognizable rank. */
export interface CellHint {
  sample: boolean;
  rank: number | null;
}

/**
 * A cell's footballers best known first, exactly as the runtime orders them (football-grid-eligibility.repo.ts
 * getBoardCells): the board's hints (samples, then recognizable rank), then the version's frozen rank, then id.
 */
export function orderCell(ids: readonly string[], hints: ReadonlyMap<string, CellHint>, rankScore: (playerId: string) => number): string[] {
  return [...ids].sort((a, b) => {
    const ha = hints.get(a);
    const hb = hints.get(b);
    const sa = ha?.sample ?? false;
    const sb = hb?.sample ?? false;
    if (sa !== sb) return sa ? -1 : 1;
    const ra = ha?.rank ?? Infinity;
    const rb = hb?.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    return rankScore(b) - rankScore(a) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

const CHOICE_CORRECT_POOL = 6;

/**
 * Whatever right answer a pick-from-four turn draws (one of the cell's best six), the runtime's own option builder
 * fills four options: each candidate is tried alone (the others marked used, which only shrinks the right pool).
 * Wrong options never depend on the draw's randomness beyond picking among an already sufficient pool.
 */
export function choiceAvailable(
  cells: readonly string[][],
  cellIndex: number,
  names: ReadonlyMap<string, { nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null }>,
): boolean {
  const players = new Map<number, FootballGridBoardPlayer[]>(cells.map((ids, index) => [index, ids.map((playerId) => {
    const player = names.get(playerId);
    return { cellIndex: index, playerId, name: player?.nameEn ?? playerId, nameKa: player?.nameKa ?? null, nameRu: player?.nameRu ?? null, nameEl: player?.nameEl ?? null, imageUrl: null };
  })]));
  const cell = cells[cellIndex] ?? [];
  if (cell.length === 0) return false;
  return cell.slice(0, CHOICE_CORRECT_POOL).every((candidate) => buildFootballGridOptions({
    players, cellIndex, usedPlayerIds: new Set(cell.filter((playerId) => playerId !== candidate)),
    seed: `certify:${cellIndex}:${candidate}`, secret: 'certification',
  }) !== null);
}

/**
 * The release validator's bar under the version (answers per cell, two recognizable answers, a nine-player distinct
 * matching) plus whether every empty cell can offer four distinguishable options (pick-from-four games).
 */
export function certifyBoard(input: CertificationInput): { status: 'certified' | 'rejected'; metrics: Record<string, unknown> } {
  const candidate: FootballGridBoardCandidate = {
    rows: input.rows,
    columns: input.columns,
    cells: input.cells.map((playerIds, index) => ({ playerIds, recognizablePlayerIds: input.recognizable[index] ?? [] })),
    checksum: input.checksum,
    theme: input.theme,
  } as unknown as FootballGridBoardCandidate;
  const result = validateFootballGridBoard(candidate);
  const choiceOk = input.cells.every((_cell, cellIndex) => choiceAvailable(input.cells, cellIndex, input.names));
  return {
    status: result.valid ? 'certified' : 'rejected',
    metrics: {
      errors: result.errors.slice(0, 12),
      cellSizes: input.cells.map((cell) => cell.length),
      choiceOk,
    },
  };
}
