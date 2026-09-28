/**
 * Pure helpers for the WL content import: what a question "is" for duplicate
 * purposes, the shape rules a WL round imposes on top of the generic question
 * schema, and the accepted-answer expansion typed rounds need.
 *
 * Dedupe is CONTENT-level on purpose. The 2026-09-11 batch had four photo
 * questions that looked new by id but had been played a week earlier under a
 * re-ingested twin — only matching normalized text against every previously
 * dealt wl_questions row catches that.
 */

import type { I18nField } from '../../db/types.js';

export type WlContentKind = 'true_false' | 'put_in_order' | 'mcq_single' | 'career_path' | 'clue_chain';
export const WL_CONTENT_KINDS: readonly WlContentKind[] = ['true_false', 'put_in_order', 'mcq_single', 'career_path', 'clue_chain'];

/** wl_questions.kind → questions.type */
export const WL_KIND_TO_TYPE: Record<string, WlContentKind> = {
  true_false: 'true_false',
  put_in_order: 'put_in_order',
  mcq: 'mcq_single',
  // Money drop bet on ordinary MCQs — a historical twin can hide there too.
  money_drop: 'mcq_single',
  career_path: 'career_path',
  who_am_i: 'clue_chain',
};

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const en = (f: I18nField | string | null | undefined): string =>
  typeof f === 'string' ? f : (f?.['en'] ?? '');

/**
 * Content key of a question payload as the CMS submits it (bulk-create shape)
 * or as stored in question_payloads. Same key ⇒ same question to a player.
 */
export function contentKeyOf(type: string, prompt: I18nField | string | null | undefined, payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {};
  switch (type) {
    case 'career_path':
    case 'clue_chain': {
      const answer = normalizeText(en(p['display_answer'] as I18nField | undefined));
      return answer ? `${type}:${answer}` : null;
    }
    case 'put_in_order': {
      const items = (p['items'] as Array<{ label?: I18nField | string }> | undefined) ?? [];
      const labels = items.map((i) => normalizeText(en(i.label))).filter(Boolean).sort();
      return labels.length ? `${type}:${labels.join('|')}` : null;
    }
    case 'true_false':
    case 'mcq_single': {
      const text = normalizeText(en(prompt));
      return text ? `${type}:${text}` : null;
    }
    default:
      return null;
  }
}

/** Content key of a dealt wl_questions row (payload/evaluation split). */
export function contentKeyOfDealt(kind: string, payload: Record<string, unknown>, evaluation: Record<string, unknown>): string | null {
  const type = WL_KIND_TO_TYPE[kind];
  if (!type) return null;
  if (type === 'career_path' || type === 'clue_chain') {
    return contentKeyOf(type, null, { display_answer: evaluation['display_answer'] });
  }
  return contentKeyOf(type, payload['prompt'] as I18nField | undefined, payload);
}

export interface ContentKeys {
  /** Same question to a player (prompt + answer). Match ⇒ duplicate. */
  exact: string | null;
  /** Same subject, possibly a different question (prompt only / item set only). Match ⇒ "similar" warning. */
  loose: string | null;
}

/**
 * Two-tier keys. A photo round may reuse "Who is this player?" for different
 * players and a ranking may reuse one item set under a different criterion,
 * so the loose (subject) key alone must not block — the exact key adds the
 * answer for mcq and the full ordered answer for put in order.
 */
export function contentKeysOf(type: string, prompt: I18nField | string | null | undefined, payload: Record<string, unknown> | null | undefined): ContentKeys {
  const loose = contentKeyOf(type, prompt, payload);
  if (!loose) return { exact: null, loose: null };
  const p = payload ?? {};
  if (type === 'mcq_single') {
    const options = (p['options'] as Array<{ text?: I18nField | string; is_correct?: boolean }> | undefined) ?? [];
    const correct = normalizeText(en(options.find((o) => o.is_correct)?.text));
    return { exact: `${loose}=${correct}`, loose };
  }
  if (type === 'put_in_order') {
    const items = (p['items'] as Array<{ label?: I18nField | string; sort_value?: number }> | undefined) ?? [];
    const ordered = [...items].sort((a, b) => Number(a.sort_value) - Number(b.sort_value)).map((i) => normalizeText(en(i.label)));
    // Same four items in the same order under a DIFFERENT criterion is a
    // different question (titles vs founding year can coincide) — the
    // criterion is part of the exact key; the item set alone is the loose key.
    return { exact: `${loose}=${ordered.join('>')}@${normalizeText(en(prompt))}`, loose };
  }
  return { exact: loose, loose };
}

/** Same two-tier keys for a dealt wl_questions row. */
export function contentKeysOfDealt(kind: string, payload: Record<string, unknown>, evaluation: Record<string, unknown>): ContentKeys {
  const type = WL_KIND_TO_TYPE[kind];
  if (!type) return { exact: null, loose: null };
  if (type === 'mcq_single') {
    const options = (payload['options'] as Array<{ id?: string; text?: I18nField | string }> | undefined) ?? [];
    const correctId = evaluation['correct_id'];
    const withKey = options.map((o) => ({ ...o, is_correct: o.id === correctId }));
    return contentKeysOf(type, payload['prompt'] as I18nField | undefined, { options: withKey });
  }
  if (type === 'put_in_order') {
    const items = (payload['items'] as Array<{ id?: string; label?: I18nField | string }> | undefined) ?? [];
    const order = (evaluation['order'] as string[] | undefined) ?? [];
    const ranked = items.map((i) => ({ ...i, sort_value: order.indexOf(String(i.id)) + 1 }));
    return contentKeysOf(type, payload['prompt'] as I18nField | undefined, { items: ranked });
  }
  const loose = contentKeyOfDealt(kind, payload, evaluation);
  return { exact: loose, loose };
}

// ─── Accepted-answer expansion (career_path / clue_chain) ─────────────────────

const PARTICLES = new Set(['de', 'di', 'da', 'van', 'von', 'del', 'der', 'la', 'le', 'den', 'dos', 'du', 'el', 'ten', 'ter']);
const KA_PARTICLES = new Set(['დე', 'დი', 'და', 'ვან', 'ფონ', 'ვონ', 'დელ', 'დერ', 'ლა', 'ლე', 'დოს', 'ელ', 'ტერ', 'ტენ']);
/** Never creditable on their own. */
const GENERIC = new Set(['junior', 'jr', 'senior', 'sr', 'ii', 'iii', 'უმცროსი']);

function variantsOf(name: string, particles: Set<string>): string[] {
  const clean = name.trim();
  if (clean === '') return [];
  const out = [clean];
  const tokens = clean.split(/\s+/);
  if (tokens.length >= 2) {
    let i = tokens.length - 1;
    while (i - 1 >= 1 && particles.has(tokens[i - 1]!.toLowerCase())) i -= 1;
    const family = tokens.slice(i).join(' ');
    if (!GENERIC.has(family.toLowerCase())) out.push(family);
    const last = tokens[tokens.length - 1]!;
    if (!GENERIC.has(last.toLowerCase())) out.push(last);
    const first = tokens[0]!;
    if (first.length >= 3 && !particles.has(first.toLowerCase())) out.push(first);
  }
  return out;
}

/** Georgian nominative appends -ი to foreign surnames; players type both. */
function kaTrimmed(variants: string[]): string[] {
  return variants.filter((v) => v.length >= 4 && v.endsWith('ი')).map((v) => v.slice(0, -1));
}

/**
 * Full name, family name (with particles), bare surname, given name, in EN
 * and KA, plus KA forms without the -ი suffix — deduped through the same
 * normalization the live matcher uses. Existing aliases are kept first.
 */
export function expandAcceptedAnswers(displayAnswer: I18nField, existing: readonly string[] = []): string[] {
  const kaBase = variantsOf(displayAnswer['ka'] ?? '', KA_PARTICLES);
  const candidates = [...existing, ...variantsOf(displayAnswer['en'] ?? '', PARTICLES), ...kaBase, ...kaTrimmed(kaBase)];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const c of candidates) {
    const key = normalizeText(c);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(c.trim());
  }
  return merged;
}

// ─── WL shape rules ───────────────────────────────────────────────────────────

export interface WlShapeIssue { code: string; message: string; severity: 'error' | 'warning' }

export const WL_PIO_ITEMS = 4;
export const WL_WHOAMI_CLUES = 5;

/**
 * Rules the WL rounds impose beyond the generic question schema (which the
 * bulk-create endpoint already enforces): the photo round needs a photo, put
 * in order plays exactly 4 items, who-am-I reveals exactly 5 clues.
 */
export function wlShapeIssues(type: string, payload: Record<string, unknown> | null | undefined): WlShapeIssue[] {
  const p = payload ?? {};
  const issues: WlShapeIssue[] = [];
  if (type === 'mcq_single') {
    const image = p['image'] as { url?: string } | null | undefined;
    // The mcq round is the photo round: the draw takes photo questions first and
    // falls back to text only when photos run out — publishable, but flagged.
    if (!image?.url) issues.push({ code: 'mcq_no_image', message: 'No Image line — text questions are dealt only when photo questions run out', severity: 'warning' });
    const options = (p['options'] as Array<{ is_correct?: boolean }> | undefined) ?? [];
    if (options.length !== 4) issues.push({ code: 'mcq_options', message: `Needs exactly 4 options (got ${options.length})`, severity: 'error' });
    if (options.filter((o) => o.is_correct).length !== 1) issues.push({ code: 'mcq_key', message: 'Exactly one option must be marked correct (*)', severity: 'error' });
  }
  if (type === 'put_in_order') {
    const items = (p['items'] as unknown[] | undefined) ?? [];
    if (items.length !== WL_PIO_ITEMS) issues.push({ code: 'pio_items', message: `Put in order plays exactly ${WL_PIO_ITEMS} items (got ${items.length})`, severity: 'error' });
    const values = (items as Array<{ sort_value?: number }>).map((i) => Number(i.sort_value));
    if (new Set(values).size !== values.length) issues.push({ code: 'pio_ties', message: 'Two items share a rank — the answer key would be ambiguous', severity: 'error' });
    // The parser assigns rank 0 to an item the Answer block forgot, and the
    // seeder sorts ascending — that item would silently become the "first".
    const expected = Array.from({ length: items.length }, (_, i) => i + 1);
    if (items.length && [...values].sort((a, b) => a - b).join(',') !== expected.join(',')) {
      issues.push({ code: 'pio_ranks', message: `Answer must list every item exactly once (ranks 1–${items.length})`, severity: 'error' });
    }
    const labels = (items as Array<{ label?: I18nField | string }>).map((i) => normalizeText(en(i.label)));
    if (new Set(labels).size !== labels.length) issues.push({ code: 'pio_dupe_items', message: 'Two items have the same name', severity: 'error' });
  }
  if (type === 'clue_chain') {
    const clues = (p['clues'] as unknown[] | undefined) ?? [];
    if (clues.length !== WL_WHOAMI_CLUES) issues.push({ code: 'whoami_clues', message: `Who am I reveals exactly ${WL_WHOAMI_CLUES} clues (got ${clues.length})`, severity: 'error' });
    const answer = en((p['display_answer'] as I18nField | undefined));
    const leak = (p['clues'] as Array<{ content?: I18nField }> | undefined)?.some((c) => {
      const text = normalizeText(en(c.content));
      const surname = normalizeText(answer).split(' ').pop() ?? '';
      return surname.length >= 4 && text.includes(surname);
    });
    if (leak) issues.push({ code: 'whoami_leak', message: 'A clue contains the answer\'s surname', severity: 'warning' });
  }
  if (type === 'career_path') {
    const clubs = (p['clubs'] as unknown[] | undefined) ?? [];
    if (clubs.length < 2) issues.push({ code: 'career_clubs', message: 'A career needs at least 2 clubs', severity: 'error' });
    if (clubs.length > 12) issues.push({ code: 'career_long', message: `${clubs.length} clubs will not fit the career strip comfortably`, severity: 'warning' });
  }
  if (type === 'career_path' || type === 'clue_chain') {
    const accepted = (p['accepted_answers'] as string[] | undefined) ?? [];
    const answer = en(p['display_answer'] as I18nField | undefined);
    if (!answer.trim()) issues.push({ code: 'no_answer', message: 'Missing answer', severity: 'error' });
    const generic = accepted.filter((a) => normalizeText(a).length <= 3);
    if (generic.length) issues.push({ code: 'short_alias', message: `Very short alias would be too easy to hit by accident: ${generic.join(', ')}`, severity: 'warning' });
  }
  return issues;
}
