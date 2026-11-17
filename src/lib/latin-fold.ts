/**
 * Latin letters Unicode does not decompose into a base letter and a mark, folded the way players type them without
 * the accent ("Østvik" → "ostvik", "Głąbek" → "glabek", "Yılmazer" → "yilmazer"). Lower-case only:
 * fold after lower-casing.
 */
const LATIN_FOLD: Readonly<Record<string, string>> = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'ı': 'i', 'þ': 'th', 'ħ': 'h', 'ŀ': 'l', 'ŧ': 't', 'ĳ': 'ij',
  // Not Latin, but the same kind of keyboard variant: Greek final sigma is σ.
  'ς': 'σ',
};
const FOLDABLE = new RegExp(`[${Object.keys(LATIN_FOLD).join('')}]`, 'gu');

export function foldLatin(lowered: string): string {
  return lowered.replace(FOLDABLE, (ch) => LATIN_FOLD[ch] ?? ch);
}
