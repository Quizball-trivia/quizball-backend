/**
 * Component-based nickname generator. Raw material comes from the curated pools;
 * COMBINATION RATES (surname append, digits, casing, separators, football
 * tokens) come from the MEASURED patterns.json.
 *
 * Uniqueness is the caller's job (an ordered pass in roster.ts against the
 * frozen exclusion set ∪ names emitted so far). This module only builds ONE
 * candidate from a supplied per-bot name RNG and an attempt counter; the attempt
 * counter WIDENS the grammar (enables more optional slots, larger digit range)
 * so repeated attempts explore more of the reachable space WITHOUT ever falling
 * back to a bot-tell like "player_00473".
 */

import type { NameStructurePatterns, WeightedString } from './patterns.js';
import {
  CLUBS,
  DIMINUTIVE_SUFFIXES,
  FIRST_NAMES_F,
  FIRST_NAMES_M,
  FOOTBALL_TOKENS,
  SURNAME_STEMS,
  SURNAME_SUFFIXES,
  TRANSLIT_VARIANTS,
} from './pools.js';
import { chance, pick, randInt, weightedPick, type Rng } from './prng.js';

export interface NameBuildContext {
  rng: Rng;
  patterns: NameStructurePatterns;
  /** 0-based attempt index; higher = widen grammar to escape collisions. */
  attempt: number;
}

function applyTranslitVariant(rng: Rng, s: string): string {
  // Low-rate transliteration swap (Talakhadze -> Talaxadze style).
  if (!chance(rng, 0.15)) return s;
  const variant = pick(rng, TRANSLIT_VARIANTS);
  return s.replace(variant.from, variant.to);
}

function buildSurname(rng: Rng): string {
  let stem = pick(rng, SURNAME_STEMS);
  const suffix = weightedPick(
    rng,
    SURNAME_SUFFIXES.map((s) => s.value),
    SURNAME_SUFFIXES.map((s) => s.weight),
  );
  // Avoid awkward doubling when a stem already ends in a suffix-like fragment
  // (e.g. "Turash" + "shvili" -> "Turashvili", "Iashvil" + "shvili" -> "Iashvili").
  const overlap = ['shvil', 'sh', 'idz', 'adz', 'ian', 'av', 'el', 'ua'];
  for (const frag of overlap) {
    if (suffix.startsWith(frag) && stem.toLowerCase().endsWith(frag)) {
      stem = stem.slice(0, stem.length - frag.length);
      break;
    }
  }
  return applyTranslitVariant(rng, stem + suffix);
}

function firstName(rng: Rng): string {
  // Female roots at roughly their real minority share (~15%).
  const pool = chance(rng, 0.15) ? FIRST_NAMES_F : FIRST_NAMES_M;
  return pick(rng, pool);
}

function digitTokenFrom(rng: Rng, tokens: WeightedString[], attempt: number): string {
  // Prefer measured trailing tokens; widen to a broader numeric range as attempts grow.
  if (tokens.length > 0 && attempt < 2 && chance(rng, 0.7)) {
    return weightedPick(
      rng,
      tokens.map((t) => t.value),
      tokens.map((t) => t.weight),
    );
  }
  // Widened range: 1-3 digits, occasionally zero-padded like real "09".
  const digits = randInt(rng, 1, attempt >= 2 ? 4 : 3);
  const n = randInt(rng, 0, Math.pow(10, digits) - 1);
  const padded = String(n).padStart(chance(rng, 0.2) ? digits : String(n).length, '0');
  return padded;
}

function applyCasing(rng: Rng, s: string, p: NameStructurePatterns): string {
  // Only lower/upper a single-token name; multi-word first+last stays TitleCase.
  const r = rng();
  if (r < p.casing.allLower) return s.toLowerCase();
  if (r < p.casing.allLower + p.casing.allUpper) return s.toUpperCase();
  return s;
}

/**
 * Build one candidate nickname. Deterministic given (rng state, patterns,
 * attempt). Returns a plausible human-style name; never returns a
 * counter/timestamp fallback.
 */
export function buildCandidate(ctx: NameBuildContext): string {
  const { rng, patterns: p, attempt } = ctx;

  // Rare Georgian-script name (presence-only; kept small). Widened cohort rate.
  // Handled by a tiny curated set to avoid transliteration ambiguity.
  if (chance(rng, Math.min(p.georgianScriptRate * 1.5, 0.02))) {
    const georgianRoots = ['კოკა', 'ნიკა', 'გიო', 'ლუკა', 'ზუკა', 'დათო', 'გუგა', 'ბექა', 'ლევანი', 'ოთო'];
    let name = pick(rng, georgianRoots);
    if (chance(rng, p.digitRate)) name += digitTokenFrom(rng, p.trailingDigitTokens, attempt);
    return name;
  }

  // Two-word first+last vs single-word, at the measured rate. Every attempt
  // re-rolls this at the SAME rate (no attempt-based bias toward two-word) so
  // the realized word-count distribution matches the target regardless of how
  // many redraws collisions force. Escape from collisions comes from widening
  // the SINGLE-word entropy below (diminutives, initials, digits), not from
  // flipping structure.
  const wantTwoWord = rng() < p.twoWordRate;

  let core: string;
  if (wantTwoWord) {
    // Real first+last names appear both TitleCase ("Giorgi Darakhvelidze") and
    // all-lowercase ("luka kalatozi", "zuka arsenishvili"), so casing applies to
    // two-word names too — otherwise the overall lowercase rate falls short.
    core = applyCasing(rng, `${firstName(rng)} ${buildSurname(rng)}`, p);
  } else {
    // Single token with high entropy so it rarely collides out (which would
    // otherwise skew the realized distribution toward the roomier two-word
    // space). A first name, football token, or bare surname, then an optional
    // diminutive/initial suffix — all space-free, so this stays single-word.
    const roll = rng();
    if (roll < 0.12) {
      core = pick(rng, FOOTBALL_TOKENS);
    } else if (roll < 0.2) {
      core = buildSurname(rng);
    } else {
      core = firstName(rng);
      const dim = rng();
      // Diminutive (Guga->Gugo) or a joined trailing initial (GugaK) — no space,
      // so these remain single-word tokens. Applied at a high rate so the plain
      // first-name pool (small) does not collide out and skew the realized
      // word-count distribution toward the roomier two-word space. Later attempts
      // push it further.
      const dimP = attempt >= 1 ? 0.85 : 0.62;
      if (dim < dimP * 0.55) core += pick(rng, DIMINUTIVE_SUFFIXES);
      else if (dim < dimP) core += pick(rng, 'ABGDKLMNRSTZ'.split(''));
    }
    core = applyCasing(rng, core, p);
  }

  // Separators: real names overwhelmingly use space (first+last) or none. A tiny
  // fraction use _ or . — apply only to single-token cores.
  if (!wantTwoWord) {
    const sepRoll = rng();
    if (sepRoll < p.separators.underscore) {
      core = core.replace(/\s+/g, '_');
      if (!core.includes('_') && chance(rng, 0.5)) core += `_${pick(rng, FIRST_NAMES_M).toLowerCase()}`;
    } else if (sepRoll < p.separators.underscore + p.separators.dot) {
      core += `.${pick(rng, FOOTBALL_TOKENS)}`;
    }
  }

  // Digits. Real single-word names carry most of the digit tokens (Vaska22,
  // Levan14, kukusha09), so single-word names get a higher digit rate — this
  // both matches the corpus and expands single-word entropy so it does not
  // collide out. Two-word first+last names rarely carry digits. The blended
  // rate lands near the measured overall digitRate.
  const baseDigitP = wantTwoWord ? p.digitRate * 0.25 : Math.min(p.digitRate * 1.5, 0.3);
  const digitP = attempt >= 1 ? Math.min(baseDigitP * 1.6, 0.5) : baseDigitP;
  if (chance(rng, digitP)) {
    core += digitTokenFrom(rng, p.trailingDigitTokens, attempt);
  }

  return core.trim();
}

/** Bias a rename toward an evolution of the current name (PR5 propensity seam). */
export function buildRenameCandidate(ctx: NameBuildContext, currentName: string): string {
  const { rng } = ctx;
  // 60%: mutate the existing name (add/drop digits, separator swap); else fresh.
  if (chance(rng, 0.6)) {
    let name = currentName;
    const hasDigits = /\d+$/.test(name);
    if (hasDigits && chance(rng, 0.5)) {
      name = name.replace(/\d+$/, '');
    } else {
      name = name.replace(/\d+$/, '') + digitTokenFrom(rng, ctx.patterns.trailingDigitTokens, ctx.attempt);
    }
    return name.trim();
  }
  return buildCandidate(ctx);
}

/** Exposed for the effective-combination-space sanity check. */
export const NAME_POOL_SIZES = {
  firstNamesM: FIRST_NAMES_M.length,
  firstNamesF: FIRST_NAMES_F.length,
  surnameStems: SURNAME_STEMS.length,
  surnameSuffixes: SURNAME_SUFFIXES.length,
  footballTokens: FOOTBALL_TOKENS.length,
  clubs: CLUBS.length,
};
