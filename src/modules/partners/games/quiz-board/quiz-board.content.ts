/** Draws a Quiz Board from the published MCQ bank: 3 categories that each have a valid easy, medium and hard
 *  question, preferring questions this player has not had on an earlier board. */

import type { TransactionSql } from '../../../../db/index.js';
import { asSql } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import {
  QUIZ_BOARD_DIFFICULTIES,
  QUIZ_BOARD_OPTIONS,
  type QuizBoardDifficulty,
} from './quiz-board.machine.js';

export type I18nText = Record<string, string>;

export interface QuizBoardImage {
  url: string;
  width: number;
  height: number;
}

export interface DrawnQuestion {
  questionId: string;
  difficulty: QuizBoardDifficulty;
  prompt: I18nText;
  /** Stored order; the play's seed shuffles it for display. */
  options: I18nText[];
  correctIndex: number;
  image: QuizBoardImage | null;
}

export interface DrawnCategory {
  id: string;
  name: I18nText;
  /** easy, medium, hard */
  questions: [DrawnQuestion, DrawnQuestion, DrawnQuestion];
}

/** A category qualifies with this many eligible questions in all (keeps tiny and test categories off boards). */
const MIN_CATEGORY_QUESTIONS = 20;
/** Spare candidates per (category, difficulty) and spare categories, so a malformed legacy row never fails a draw. */
const CANDIDATES_PER_SLOT = 4;
const CATEGORY_CANDIDATES = 8;

interface CandidateRow {
  category_id: string;
  category_name: unknown;
  category_rank: number;
  id: string;
  difficulty: QuizBoardDifficulty;
  prompt: unknown;
  payload: unknown;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseI18n(value: unknown): I18nText | null {
  const parsed = parseJson(value);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed).filter(([, text]) => typeof text === 'string' && text.trim().length > 0);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as I18nText;
}

function parseImage(payload: Record<string, unknown>): QuizBoardImage | null | undefined {
  const raw = payload.image;
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const image = raw as { url?: unknown; width?: unknown; height?: unknown };
  if (typeof image.url !== 'string' || !/^https:\/\//.test(image.url)) return null;
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) return null;
  if ((image.width as number) <= 0 || (image.height as number) <= 0) return null;
  return { url: image.url, width: image.width as number, height: image.height as number };
}

/** A question the board can show: a prompt, exactly 4 options with exactly one right, a usable image if any. */
export function parseQuestion(row: Pick<CandidateRow, 'id' | 'difficulty' | 'prompt' | 'payload'>): DrawnQuestion | null {
  const prompt = parseI18n(row.prompt);
  const payload = parseJson(row.payload);
  if (!prompt || payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rawOptions = (payload as { options?: unknown }).options;
  if (!Array.isArray(rawOptions) || rawOptions.length !== QUIZ_BOARD_OPTIONS) return null;
  const options: I18nText[] = [];
  let correctIndex = -1;
  for (const [index, raw] of rawOptions.entries()) {
    const option = raw as { text?: unknown; is_correct?: unknown } | null;
    const text = parseI18n(option?.text);
    if (!text || typeof option?.is_correct !== 'boolean') return null;
    if (option.is_correct) {
      if (correctIndex !== -1) return null;
      correctIndex = index;
    }
    options.push(text);
  }
  if (correctIndex === -1) return null;
  const image = parseImage(payload as Record<string, unknown>);
  if (image === null) return null;
  return { questionId: row.id, difficulty: row.difficulty, prompt, options, correctIndex, image: image ?? null };
}

async function candidates(tx: TransactionSql, partnerPlayerId: string, excludeSeen: boolean): Promise<CandidateRow[]> {
  return asSql(tx)<CandidateRow[]>`
    WITH eligible AS MATERIALIZED (
      SELECT q.id, q.category_id, q.difficulty
      FROM questions q
      JOIN categories c
        ON c.id = q.category_id AND c.is_active AND NOT c.campaign_only AND c.slug NOT LIKE 'daily-challenges%'
      WHERE q.status = 'published'
        AND q.type = 'mcq_single'
        AND q.ranked_eligible = true
        AND q.visibility = 'public'
        AND (${!excludeSeen} OR NOT EXISTS (
          SELECT 1
          FROM partner_quiz_board_tiles seen
          JOIN partner_quiz_boards b ON b.id = seen.board_id
          WHERE b.partner_player_id = ${partnerPlayerId} AND seen.question_id = q.id
        ))
    ),
    ranked_categories AS (
      SELECT category_id, row_number() OVER (ORDER BY random())::int AS category_rank
      FROM eligible
      GROUP BY category_id
      HAVING count(*) FILTER (WHERE difficulty = 'easy') > 0
         AND count(*) FILTER (WHERE difficulty = 'medium') > 0
         AND count(*) FILTER (WHERE difficulty = 'hard') > 0
         AND count(*) >= ${MIN_CATEGORY_QUESTIONS}
    ),
    picked_categories AS (
      SELECT category_id, category_rank FROM ranked_categories WHERE category_rank <= ${CATEGORY_CANDIDATES}
    ),
    slots AS (
      SELECT e.id, e.category_id, e.difficulty,
             row_number() OVER (PARTITION BY e.category_id, e.difficulty ORDER BY random()) AS slot_rank
      FROM eligible e
      JOIN picked_categories pc ON pc.category_id = e.category_id
    )
    SELECT s.category_id, c.name AS category_name, pc.category_rank, q.id, q.difficulty, q.prompt, qp.payload
    FROM slots s
    JOIN picked_categories pc ON pc.category_id = s.category_id
    JOIN categories c ON c.id = s.category_id
    JOIN questions q ON q.id = s.id
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE s.slot_rank <= ${CANDIDATES_PER_SLOT}
    ORDER BY pc.category_rank, s.slot_rank`;
}

function assemble(rows: CandidateRow[]): DrawnCategory[] {
  const byCategory = new Map<string, { name: I18nText | null; slots: Partial<Record<QuizBoardDifficulty, DrawnQuestion>> }>();
  for (const row of rows) {
    let entry = byCategory.get(row.category_id);
    if (!entry) {
      entry = { name: parseI18n(row.category_name), slots: {} };
      byCategory.set(row.category_id, entry);
    }
    if (entry.slots[row.difficulty]) continue;
    const question = parseQuestion(row);
    if (question) entry.slots[row.difficulty] = question;
  }
  const drawn: DrawnCategory[] = [];
  for (const [id, entry] of byCategory) {
    const [easy, medium, hard] = QUIZ_BOARD_DIFFICULTIES.map((d) => entry.slots[d]);
    if (!entry.name || !easy || !medium || !hard) continue;
    drawn.push({ id, name: entry.name, questions: [easy, medium, hard] });
    if (drawn.length === 3) break;
  }
  return drawn;
}

export async function drawBoard(tx: TransactionSql, partnerPlayerId: string): Promise<DrawnCategory[]> {
  let drawn = assemble(await candidates(tx, partnerPlayerId, true));
  // A regular who has seen most of the bank still gets a board, with repeats.
  if (drawn.length < 3) drawn = assemble(await candidates(tx, partnerPlayerId, false));
  if (drawn.length < 3) throw new PartnerError('game_not_available', 'Not enough questions for a board');
  return drawn;
}
