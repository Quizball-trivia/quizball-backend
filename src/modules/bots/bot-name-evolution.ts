/**
 * Evolution-biased nickname mutation for roster-bot renames (§1.12).
 *
 * A rename must read as the SAME person adjusting their handle — "Levan14" →
 * "Levan", "gio_k" → "gio.k", "Vaska" → "Vaskiko" — not as a new account. Real
 * renames in the measured corpus overwhelmingly keep the recognisable stem and
 * change only its decoration, so every mutation here preserves the stem and
 * touches exactly one of: trailing digits, separator, diminutive suffix, or
 * casing.
 *
 * WHY THIS IS A SEPARATE MODULE from `scripts/persistent-bot-roster/
 * name-generator.ts`: that generator is a build-time script outside the app's
 * `rootDir` (tsconfig.json `"rootDir": "./src"`), so runtime code cannot import
 * it. Rather than widen the compile boundary for one function, the small subset
 * a rename needs — stem-preserving mutation only, never a fresh identity — is
 * reimplemented here against the same pools and the same mulberry32/xmur3
 * streams, so both sides stay reproducible and comparable.
 */

/** Diminutive suffixes, mirroring scripts/persistent-bot-roster/pools.ts. */
const DIMINUTIVE_SUFFIXES = ['o', 'a', 'ika', 'ka', 'iko', 'ushka', 'una'] as const;

/** Trailing-initial letters, mirroring the roster generator's joined-initial slot. */
const INITIALS = 'ABGDKLMNRSTZ'.split('');

/** Separators a real handle swaps between. */
const SEPARATORS = ['_', '.'] as const;

/** Mirrors the nickname cap enforced on the human update path (users.schemas.ts). */
export const MAX_NICKNAME_LENGTH = 50;

export type Rng = () => number;

/** xmur3 string hash → 32-bit seed. Identical to the roster generator's. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: deterministic uniform in [0, 1). Identical to the roster generator's. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent stream from a stable string key. */
export function rngFromKey(key: string): Rng {
  const gen = xmur3(key);
  return mulberry32((gen() ^ gen()) >>> 0);
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Split a handle into its stem and any trailing digit run. */
function splitTrailingDigits(name: string): { stem: string; digits: string } {
  const match = /^(.*?)(\d+)$/.exec(name);
  if (!match) return { stem: name, digits: '' };
  return { stem: match[1]!, digits: match[2]! };
}

/**
 * Build an evolved handle from the current one.
 *
 * Deterministic given (rng stream, currentName, attempt). The attempt counter
 * widens the digit range so a uniqueness-collision retry explores more space
 * without ever degrading into a bot-tell like "bot_00473".
 *
 * Returns the mutated name, or null when the mutation produced no change (the
 * caller retries with a higher attempt).
 */
export function buildEvolvedNickname(rng: Rng, currentName: string, attempt = 0): string | null {
  const trimmed = currentName.trim();
  if (!trimmed) return null;

  const { stem, digits } = splitTrailingDigits(trimmed);
  const roll = rng();

  // A digits-only handle ("12345") has no alphabetic stem to evolve: splitting
  // it leaves stem='' , so the letter-appending branches below would emit
  // "ushka12345" (a different person) and the digit branch would emit a bare
  // "4" (the recognisable handle gone). Neither is an evolution. Digits-only
  // names are vanishingly rare in the roster; skipping them entirely is
  // correct and keeps every remaining mutation stem-preserving.
  if (stem.length === 0) return null;

  let next: string;

  if (roll < 0.4) {
    // Digit churn — the single most common real evolution. Drop an existing
    // run, or (re)attach a fresh one to the bare stem.
    if (digits && chance(rng, 0.45)) {
      next = stem;
    } else {
      const width = randInt(rng, 1, attempt >= 2 ? 4 : 2);
      const value = randInt(rng, 0, Math.pow(10, width) - 1);
      const rendered = chance(rng, 0.2)
        ? String(value).padStart(width, '0')
        : String(value);
      next = stem + rendered;
    }
  } else if (roll < 0.6) {
    // Separator swap: gio_k -> gio.k, or joining/splitting an existing one.
    if (/[_.]/.test(stem)) {
      const current = stem.includes('_') ? '_' : '.';
      const replacement = current === '_' ? '.' : '_';
      next = chance(rng, 0.3)
        ? stem.replace(/[_.]/g, '') + digits
        : stem.replace(/[_.]/g, replacement) + digits;
    } else {
      next = stem + pick(rng, SEPARATORS) + pick(rng, INITIALS).toLowerCase() + digits;
    }
  } else if (roll < 0.8) {
    // Diminutive / initial churn on the stem itself (Vaska -> Vaskiko).
    const base = stem.replace(/[_.]$/, '');
    next = chance(rng, 0.7)
      ? base + pick(rng, DIMINUTIVE_SUFFIXES) + digits
      : base + pick(rng, INITIALS) + digits;
  } else {
    // Casing flip — a real and very common "same person, new look" edit. Only
    // meaningful when the handle actually has letters to recase.
    const lower = trimmed.toLowerCase();
    const upper = trimmed.toUpperCase();
    next = trimmed === lower ? upper : lower;
  }

  next = next.trim();
  // A separator must never lead or trail: no real handle looks like "_gio" or
  // "gio.". Reachable when the source stem is itself separator-heavy.
  next = next.replace(/^[_.]+/, '').replace(/[_.]+$/, '');
  if (!next || next === trimmed) return null;
  // Mutations append, so a near-limit name can overflow the 50-char nickname
  // cap. Reject rather than truncate — a chopped handle reads as corrupted,
  // and the caller simply retries or skips this bot.
  if (next.length > MAX_NICKNAME_LENGTH) return null;
  return next;
}
