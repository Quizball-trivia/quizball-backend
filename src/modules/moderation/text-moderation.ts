export type ModerationLanguage = 'en' | 'ka' | 'translit' | 'global';

export interface BannedTerm {
  term: string;
  language: ModerationLanguage;
  reason: 'hate' | 'sexual' | 'harassment' | 'violence' | 'extremism' | 'impersonation';
  matchMode?: 'contains' | 'exact';
  allowedSubstrings?: string[];
}

const LEETSPEAK_EQUIVALENTS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  '$': 's',
  '7': 't',
};

const BANNED_NICKNAME_TERMS: BannedTerm[] = [
  // Severe hate/slur terms: use contains because users often wrap them in clan tags or numbers.
  { term: 'beaner', language: 'en', reason: 'hate' },
  { term: 'chink', language: 'en', reason: 'hate' },
  { term: 'coon', language: 'en', reason: 'hate' },
  { term: 'darkie', language: 'en', reason: 'hate' },
  { term: 'fag', language: 'en', reason: 'hate', matchMode: 'exact' },
  { term: 'faggot', language: 'en', reason: 'hate' },
  { term: 'gook', language: 'en', reason: 'hate' },
  { term: 'honkey', language: 'en', reason: 'hate' },
  { term: 'jigaboo', language: 'en', reason: 'hate' },
  { term: 'kike', language: 'en', reason: 'hate' },
  { term: 'nigga', language: 'en', reason: 'hate' },
  { term: 'nigger', language: 'en', reason: 'hate' },
  { term: 'paki', language: 'en', reason: 'hate' },
  { term: 'raghead', language: 'en', reason: 'hate' },
  { term: 'retard', language: 'en', reason: 'hate' },
  { term: 'spastic', language: 'en', reason: 'hate' },
  { term: 'spic', language: 'en', reason: 'hate' },
  { term: 'towelhead', language: 'en', reason: 'hate' },
  { term: 'tranny', language: 'en', reason: 'hate' },
  { term: 'wetback', language: 'en', reason: 'hate' },

  // Extremism and direct violent-threat style nicknames.
  { term: 'hitler', language: 'en', reason: 'extremism' },
  { term: 'kkk', language: 'en', reason: 'extremism', matchMode: 'exact' },
  { term: 'neonazi', language: 'en', reason: 'extremism' },
  { term: 'nazi', language: 'en', reason: 'extremism', matchMode: 'exact' },
  { term: 'swastika', language: 'en', reason: 'extremism' },
  { term: 'whitepower', language: 'en', reason: 'extremism' },
  { term: 'rapist', language: 'en', reason: 'violence' },

  // Common profanity/abuse. Short/high-false-positive terms use exact mode.
  { term: 'arsehole', language: 'en', reason: 'harassment' },
  { term: 'ass', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'asshole', language: 'en', reason: 'harassment' },
  { term: 'bastard', language: 'en', reason: 'harassment' },
  { term: 'bitch', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'bollocks', language: 'en', reason: 'harassment' },
  { term: 'bullshit', language: 'en', reason: 'harassment' },
  { term: 'clusterfuck', language: 'en', reason: 'harassment' },
  { term: 'crap', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'cunt', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'damn', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'douche', language: 'en', reason: 'harassment' },
  { term: 'fuck', language: 'en', reason: 'harassment' },
  { term: 'motherfucker', language: 'en', reason: 'harassment' },
  { term: 'prick', language: 'en', reason: 'harassment', matchMode: 'exact' },
  { term: 'shit', language: 'en', reason: 'harassment' },
  { term: 'slut', language: 'en', reason: 'harassment' },
  { term: 'tosser', language: 'en', reason: 'harassment' },
  { term: 'twat', language: 'en', reason: 'harassment' },
  { term: 'wank', language: 'en', reason: 'harassment' },
  { term: 'whore', language: 'en', reason: 'harassment' },

  // Explicit sexual/pornographic terms. Exact mode avoids common name/place false positives.
  { term: 'anal', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'anus', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'bdsm', language: 'en', reason: 'sexual' },
  { term: 'blowjob', language: 'en', reason: 'sexual' },
  { term: 'boob', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'boobs', language: 'en', reason: 'sexual' },
  { term: 'boner', language: 'en', reason: 'sexual' },
  { term: 'butthole', language: 'en', reason: 'sexual' },
  { term: 'camgirl', language: 'en', reason: 'sexual' },
  { term: 'camslut', language: 'en', reason: 'sexual' },
  { term: 'cock', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'cum', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'cumshot', language: 'en', reason: 'sexual' },
  { term: 'dick', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'dildo', language: 'en', reason: 'sexual' },
  { term: 'hentai', language: 'en', reason: 'sexual' },
  { term: 'horny', language: 'en', reason: 'sexual' },
  { term: 'incest', language: 'en', reason: 'sexual' },
  { term: 'jizz', language: 'en', reason: 'sexual' },
  { term: 'masturbate', language: 'en', reason: 'sexual' },
  { term: 'milf', language: 'en', reason: 'sexual' },
  { term: 'nude', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'orgasm', language: 'en', reason: 'sexual' },
  { term: 'orgy', language: 'en', reason: 'sexual' },
  { term: 'pedobear', language: 'en', reason: 'sexual' },
  { term: 'pedophile', language: 'en', reason: 'sexual' },
  { term: 'penis', language: 'en', reason: 'sexual' },
  { term: 'porn', language: 'en', reason: 'sexual' },
  { term: 'porno', language: 'en', reason: 'sexual' },
  { term: 'pornography', language: 'en', reason: 'sexual' },
  { term: 'pussy', language: 'en', reason: 'sexual' },
  { term: 'rape', language: 'en', reason: 'violence', matchMode: 'exact' },
  { term: 'raping', language: 'en', reason: 'violence' },
  { term: 'semen', language: 'en', reason: 'sexual' },
  { term: 'sex', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'sexcam', language: 'en', reason: 'sexual' },
  { term: 'sexy', language: 'en', reason: 'sexual' },
  { term: 'smut', language: 'en', reason: 'sexual' },
  { term: 'threesome', language: 'en', reason: 'sexual' },
  { term: 'tit', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'tits', language: 'en', reason: 'sexual', matchMode: 'exact' },
  { term: 'vagina', language: 'en', reason: 'sexual' },
  { term: 'vibrator', language: 'en', reason: 'sexual' },
  { term: 'xxx', language: 'en', reason: 'sexual' },
  // Georgian-script terms belong here after native-speaker moderation review.
];

export interface ModerationMatch {
  reason: BannedTerm['reason'];
  language: ModerationLanguage;
}

export function normalizeModerationText(value: string): string {
  const withoutMarks = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '');

  const deobfuscated = Array.from(withoutMarks)
    .map((char) => LEETSPEAK_EQUIVALENTS[char] ?? char)
    .join('');

  return deobfuscated.replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

export function findBannedNicknameTerm(value: string): ModerationMatch | null {
  const normalizedValue = normalizeModerationText(value);
  if (!normalizedValue) return null;

  for (const entry of BANNED_NICKNAME_TERMS) {
    const normalizedTerm = normalizeModerationText(entry.term);
    if (!normalizedTerm) continue;
    const exactCandidate = normalizeModerationText(value.replace(/^\d+|\d+$/g, ''));
    const isMatch = entry.matchMode === 'exact'
      ? normalizedValue === normalizedTerm || exactCandidate === normalizedTerm
      : normalizedValue.includes(normalizedTerm);
    const isAllowedException = entry.allowedSubstrings?.some((allowed) =>
      normalizedValue.includes(normalizeModerationText(allowed))
    ) ?? false;
    if (isMatch && !isAllowedException) {
      return {
        reason: entry.reason,
        language: entry.language,
      };
    }
  }

  return null;
}

export function isNicknameAllowed(value: string): boolean {
  return findBannedNicknameTerm(value) === null;
}
