import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';

const MIN_PREFIX_LENGTH = 3;

type AcceptedAnswerMatchKind = 'exact' | 'wholeWord' | 'alias' | 'typo';

interface AcceptedAnswerMatch {
  kind: AcceptedAnswerMatchKind;
  distance: number;
}

interface CountdownCandidate {
  id: string;
  display: Record<string, string>;
  match: AcceptedAnswerMatch;
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function levenshtein(left: string, right: string): number {
  const matrix: number[][] = [];
  for (let row = 0; row <= right.length; row += 1) {
    matrix[row] = [row];
  }
  for (let column = 0; column <= left.length; column += 1) {
    matrix[0][column] = column;
  }
  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      matrix[row][column] = right[row - 1] === left[column - 1]
        ? matrix[row - 1][column - 1]
        : Math.min(
            matrix[row - 1][column - 1] + 1,
            matrix[row][column - 1] + 1,
            matrix[row - 1][column] + 1
          );
    }
  }
  return matrix[right.length][left.length];
}

// Whole-word match: input must appear as a complete token in the accepted
// answer (surrounded by string boundaries or whitespace), not as an interior
// substring. After normalizeAnswer, the only separators are single spaces.
function containsWholeWord(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  if (haystack.startsWith(`${needle} `)) return true;
  if (haystack.endsWith(` ${needle}`)) return true;
  return haystack.includes(` ${needle} `);
}

function answerTokens(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

function tokensMatchByAlias(inputToken: string, acceptedToken: string): boolean {
  if (inputToken === acceptedToken) return true;

  const aliases = new Map([
    ['man', 'manchester'],
    ['utd', 'united'],
  ]);

  return aliases.get(inputToken) === acceptedToken
    || aliases.get(acceptedToken) === inputToken;
}

function hasTokenAliasMatch(normalizedInput: string, normalizedAccepted: string): boolean {
  const inputTokens = answerTokens(normalizedInput);
  const acceptedTokens = answerTokens(normalizedAccepted);
  if (inputTokens.length < 2 || inputTokens.length !== acceptedTokens.length) return false;

  return inputTokens.every((token, index) => tokensMatchByAlias(token, acceptedTokens[index]));
}

function maxTypoDistance(target: string): number {
  if (target.length < 5) return 0;
  return target.length > 6 ? 2 : 1;
}

function betterAcceptedMatch(
  current: AcceptedAnswerMatch | null,
  next: AcceptedAnswerMatch
): AcceptedAnswerMatch {
  if (!current) return next;

  const kindRank: Record<AcceptedAnswerMatchKind, number> = {
    exact: 3,
    wholeWord: 2,
    alias: 2,
    typo: 1,
  };

  const currentRank = kindRank[current.kind];
  const nextRank = kindRank[next.kind];
  if (nextRank !== currentRank) return nextRank > currentRank ? next : current;
  return next.distance < current.distance ? next : current;
}

function matchNormalizedAcceptedAnswer(
  normalizedInput: string,
  normalizedAccepted: string
): AcceptedAnswerMatch | null {
  if (!normalizedAccepted) return null;
  if (normalizedInput === normalizedAccepted) return { kind: 'exact', distance: 0 };
  if (containsWholeWord(normalizedAccepted, normalizedInput)) {
    return { kind: 'wholeWord', distance: 0 };
  }
  if (hasTokenAliasMatch(normalizedInput, normalizedAccepted)) {
    return { kind: 'alias', distance: 0 };
  }

  if (normalizedInput.length < 4) return null;

  const typoTargets = [normalizedAccepted, ...answerTokens(normalizedAccepted)];
  let bestTypo: AcceptedAnswerMatch | null = null;

  for (const target of typoTargets) {
    const allowedDistance = maxTypoDistance(target);
    if (allowedDistance <= 0) continue;

    const distance = levenshtein(normalizedInput, target);
    if (distance <= allowedDistance) {
      bestTypo = betterAcceptedMatch(bestTypo, { kind: 'typo', distance });
    }
  }

  return bestTypo;
}

function matchAcceptedAnswers(input: string, acceptedAnswers: string[]): AcceptedAnswerMatch | null {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return null;

  return acceptedAnswers.reduce<AcceptedAnswerMatch | null>((best, acceptedAnswer) => {
    const match = matchNormalizedAcceptedAnswer(normalizedInput, normalizeAnswer(acceptedAnswer));
    return match ? betterAcceptedMatch(best, match) : best;
  }, null);
}

export function fuzzyMatchesAnswer(input: string, acceptedAnswers: string[]): boolean {
  return matchAcceptedAnswers(input, acceptedAnswers) !== null;
}

export type ClueGuessRejectReason =
  | 'empty_normalized_guess'
  | 'empty_answer_set'
  | 'below_typo_min_length'
  | 'no_typo_eligible_target'
  | 'no_rule_matched'
  | 'give_up';

export interface ClueGuessCandidateExplanation {
  accepted: string;
  normalizedAccepted: string;
  matchedRule: AcceptedAnswerMatchKind | null;
  /** Distance of the match the matcher actually made, when it matched. */
  matchDistance: number | null;
  /**
   * Closest target the matcher was WILLING to typo-match (budget > 0), and the
   * budget that applied to it. Reporting the globally closest target instead
   * would be misleading: short tokens get a budget of 0, so a "distance 1,
   * allowed 0" pair would imply a near-miss the matcher never considered.
   * Null when no target was typo-eligible.
   */
  closestTypoTarget: string | null;
  bestDistance: number | null;
  allowedDistance: number;
  /** Closest target of any kind, ignoring eligibility. Context only. */
  nearestDistance: number | null;
}

export interface ClueGuessExplanation {
  normalizedGuess: string;
  matchedRule: AcceptedAnswerMatchKind | null;
  matchDistance: number | null;
  rejectReason: ClueGuessRejectReason | null;
  candidates: ClueGuessCandidateExplanation[];
}

/**
 * Read-only diagnosis of how `fuzzyMatchesAnswer` reached its verdict.
 *
 * Instrumentation ONLY — the live verdict still comes from
 * `fuzzyMatchesAnswer`; this never feeds back into scoring. It deliberately
 * calls the same private rule helpers rather than reimplementing them, so the
 * recorded explanation cannot drift from the rules actually applied.
 */
export function explainClueGuess(input: string, acceptedAnswers: string[]): ClueGuessExplanation {
  const normalizedGuess = normalizeAnswer(input);

  const candidates: ClueGuessCandidateExplanation[] = acceptedAnswers.map((accepted) => {
    const normalizedAccepted = normalizeAnswer(accepted);
    const match = normalizedGuess && normalizedAccepted
      ? matchNormalizedAcceptedAnswer(normalizedGuess, normalizedAccepted)
      : null;

    // Mirror the matcher's own target list, scoring typo-ELIGIBLE targets
    // separately from the global nearest, so the recorded budget always belongs
    // to the target it is reported against.
    const typoTargets = [normalizedAccepted, ...answerTokens(normalizedAccepted)];
    let closestTypoTarget: string | null = null;
    let bestDistance: number | null = null;
    let allowedDistance = 0;
    let nearestDistance: number | null = null;

    for (const target of typoTargets) {
      if (!target) continue;
      const distance = levenshtein(normalizedGuess, target);
      if (nearestDistance === null || distance < nearestDistance) {
        nearestDistance = distance;
      }
      const budget = maxTypoDistance(target);
      if (budget > 0 && (bestDistance === null || distance < bestDistance)) {
        closestTypoTarget = target;
        bestDistance = distance;
        allowedDistance = budget;
      }
    }

    return {
      accepted,
      normalizedAccepted,
      matchedRule: match?.kind ?? null,
      matchDistance: match ? match.distance : null,
      closestTypoTarget,
      bestDistance,
      allowedDistance,
      nearestDistance,
    };
  });

  // Use the distance the matcher itself produced rather than re-deriving it.
  const best = candidates.reduce<AcceptedAnswerMatch | null>((acc, candidate) => {
    if (!candidate.matchedRule) return acc;
    return betterAcceptedMatch(acc, {
      kind: candidate.matchedRule,
      distance: candidate.matchDistance ?? 0,
    });
  }, null);

  // Order matters: content-side failures are checked before guess-side ones, so
  // an unusable answer set is never mislabelled as "the player typed too little".
  let rejectReason: ClueGuessRejectReason | null = null;
  if (!best) {
    if (!normalizedGuess) rejectReason = 'empty_normalized_guess';
    else if (candidates.every((candidate) => !candidate.normalizedAccepted)) rejectReason = 'empty_answer_set';
    else if (candidates.every((candidate) => candidate.closestTypoTarget === null)) {
      // Every accepted answer was too short to earn a typo budget, so the typo
      // rule never ran. Distinct from a near-miss that blew a real budget —
      // conflating them points the investigation at the threshold instead of
      // at the fact that short names bypass typo matching entirely.
      rejectReason = 'no_typo_eligible_target';
    } else if (normalizedGuess.length < 4) rejectReason = 'below_typo_min_length';
    else rejectReason = 'no_rule_matched';
  }

  return {
    normalizedGuess,
    matchedRule: best?.kind ?? null,
    matchDistance: best ? best.distance : null,
    rejectReason,
    candidates,
  };
}

function hasPrefixMatch(acceptedAnswers: string[], normalizedGuess: string): boolean {
  return acceptedAnswers.some((accepted) => {
    const normalizedAccepted = normalizeAnswer(accepted);
    if (!normalizedAccepted) return false;
    return normalizedAccepted.startsWith(normalizedGuess)
      || answerTokens(normalizedAccepted).some((token) => token.startsWith(normalizedGuess));
  });
}

export function countdownMatch(
  evaluation: Extract<MatchQuestionEvaluation, { kind: 'countdown' }>,
  guess: string,
  foundIds: Set<string>
): { id: string; display: Record<string, string> } | null {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return null;

  const candidates = evaluation.answerGroups.reduce<CountdownCandidate[]>((matches, answerGroup) => {
    const match = matchAcceptedAnswers(guess, answerGroup.acceptedAnswers);
    if (match) {
      matches.push({
        id: answerGroup.id,
        display: answerGroup.display,
        match,
      });
    }
    return matches;
  }, []);

  for (const kind of ['exact', 'wholeWord', 'alias', 'typo'] satisfies AcceptedAnswerMatchKind[]) {
    const matchesForKind = candidates.filter((candidate) => candidate.match.kind === kind);
    if (matchesForKind.length > 0) {
      const uniqueGroupIds = new Set(matchesForKind.map((candidate) => candidate.id));
      if (uniqueGroupIds.size !== 1) return null;

      const candidate = matchesForKind[0];
      if (!foundIds.has(candidate.id)) {
        return {
          id: candidate.id,
          display: candidate.display,
        };
      }
    }
  }

  if (normalizedGuess.length >= MIN_PREFIX_LENGTH) {
    const prefixCandidates: Array<{ id: string; display: Record<string, string> }> = [];
    for (const answerGroup of evaluation.answerGroups) {
      if (hasPrefixMatch(answerGroup.acceptedAnswers, normalizedGuess)) {
        prefixCandidates.push({ id: answerGroup.id, display: answerGroup.display });
      }
    }
    if (prefixCandidates.length === 1) {
      const candidate = prefixCandidates[0];
      if (!foundIds.has(candidate.id)) return candidate;
    }
  }

  return null;
}

export function clueIndexForTimeMs(clueCount: number, timeMs: number, questionTimeMs: number): number {
  if (clueCount <= 1) return 0;
  const sliceMs = questionTimeMs / clueCount;
  return clamp(Math.floor(timeMs / sliceMs), 0, clueCount - 1);
}

// ---------------------------------------------------------------------------
// Matcher v2 — closes the two failure classes measured in the Shavski report
// while tightening the false-positive hole the fix would otherwise widen:
//   1. spaceless: a joined spelling matches its spaced accepted form
//      (დიმარია ↔ დი მარია) as an ADDITIONAL EXACT-ONLY comparison — it never
//      participates in whole-word, alias, typo or prefix logic, and both
//      spaceless forms must be ≥ SPACELESS_MIN_LENGTH code points.
//   2. whole-word guard: a bare token must be ≥ MIN_WHOLE_WORD_LENGTH code
//      points and not a name particle — before this, typing just "დი" matched
//      "დი მარია". Digit-bearing short aliases ("R9") stay allowed.
// Legacy behavior is preserved verbatim in the v1 functions above; callers
// choose per the ANSWER_MATCHER_V2 config ('on' scores with v2, 'shadow'
// scores with v1 and records the v2 verdict, 'off' ignores v2).
// ---------------------------------------------------------------------------

export const ANSWER_MATCHER_VERSION = 2;

const SPACELESS_MIN_LENGTH = 5;
const MIN_WHOLE_WORD_LENGTH = 3;

/** Name particles that must never count as a whole-word match on their own. */
const PARTICLE_STOPLIST = new Set([
  'de', 'di', 'da', 'la', 'el', 'van', 'von', 'der', 'den', 'dos', 'del', 'jr', 'junior',
  'ter', 'ten', 'das', 'bin', 'ben', 'dem', 'le', 'du', 'al',
  'დე', 'დი', 'და', 'ლა', 'ელ', 'ვან', 'ფონ', 'დერ', 'დენ', 'დოს', 'დელ', 'უმცროსი',
  'ტერ', 'ტენ', 'დას', 'ბინ', 'ბენ', 'დემ', 'ლე', 'დიუ', 'ალ',
]);

export type AnswerMatchKind = AcceptedAnswerMatchKind | 'spaceless';

export interface AnswerMatchResult {
  kind: AnswerMatchKind;
  matchedAnswer: string;
  distance: number;
}

const codePointLength = (value: string): number => [...value].length;

function spacelessForm(normalized: string): string {
  return normalized.replace(/ /g, '');
}

function wholeWordAllowed(normalizedInput: string): boolean {
  // Stoplist-only gate: at least one token must be a non-particle. A length
  // floor here silently rejected legitimate 2-letter surnames ("Demba Ba",
  // "Ze Roberto") — content the replay corpus can never surface — and a v2
  // reject in 'on' mode looks like an ordinary wrong answer, so that loss
  // would be invisible. The particles we actually fear are all enumerable.
  // countdownMatchV2's PREFIX fallback keeps a length floor separately
  // (unlimited countdown guesses make 2-letter prefix fishing cheap).
  const tokens = answerTokens(normalizedInput);
  if (tokens.length === 0) return false;
  return tokens.some((token) => !PARTICLE_STOPLIST.has(token));
}

/** Prefix fishing on countdown is cheap (unlimited guesses) — keep a floor there. */
function prefixGuessAllowed(normalizedInput: string): boolean {
  if (!wholeWordAllowed(normalizedInput)) return false;
  return codePointLength(normalizedInput) >= MIN_WHOLE_WORD_LENGTH || /\d/.test(normalizedInput);
}

function matchNormalizedAcceptedAnswerV2(
  normalizedInput: string,
  normalizedAccepted: string
): { kind: AnswerMatchKind; distance: number } | null {
  if (!normalizedAccepted) return null;
  if (normalizedInput === normalizedAccepted) return { kind: 'exact', distance: 0 };

  // Spaceless: the input's joined form must EQUAL the joined form of the full
  // accepted answer or of a contiguous multi-token span of it ("დიმარია" ↔
  // the "დი მარია" part of "ანხელ დი მარია"; "van dijk" ↔ "vandijk").
  // Symmetric in spacing on BOTH sides, exact equality only — never a
  // substring — and the joined form must be ≥ SPACELESS_MIN_LENGTH points.
  const inputSpaceless = spacelessForm(normalizedInput);
  if (codePointLength(inputSpaceless) >= SPACELESS_MIN_LENGTH) {
    const tokens = answerTokens(normalizedAccepted);
    const nonParticle = tokens.map((token) => !PARTICLE_STOPLIST.has(token));
    // A matched span must carry real name content — "vander" joined from the
    // particles of "van der Vaart" identifies nobody, same rule as whole-word.
    if (
      inputSpaceless === spacelessForm(normalizedAccepted)
      && nonParticle.some(Boolean)
    ) {
      return { kind: 'spaceless', distance: 0 };
    }
    for (let start = 0; start < tokens.length - 1; start += 1) {
      let joined = tokens[start];
      let hasContent = nonParticle[start];
      for (let end = start + 1; end < tokens.length; end += 1) {
        joined += tokens[end];
        hasContent = hasContent || nonParticle[end];
        if (joined === inputSpaceless && hasContent) return { kind: 'spaceless', distance: 0 };
        if (joined.length > inputSpaceless.length) break;
      }
    }
    // Mirror: a spaced input matching one joined accepted TOKEN
    // ("ter stegen" ↔ the "terstegen" token inside "marc terstegen").
    if (normalizedInput.includes(' ')) {
      const index = tokens.indexOf(inputSpaceless);
      if (index >= 0 && nonParticle[index]) return { kind: 'spaceless', distance: 0 };
    }
  }

  if (wholeWordAllowed(normalizedInput) && containsWholeWord(normalizedAccepted, normalizedInput)) {
    return { kind: 'wholeWord', distance: 0 };
  }
  if (hasTokenAliasMatch(normalizedInput, normalizedAccepted)) {
    return { kind: 'alias', distance: 0 };
  }

  if (normalizedInput.length < 4) return null;

  const typoTargets = [normalizedAccepted, ...answerTokens(normalizedAccepted)];
  let bestTypo: { kind: AnswerMatchKind; distance: number } | null = null;
  for (const target of typoTargets) {
    const allowedDistance = maxTypoDistance(target);
    if (allowedDistance <= 0) continue;
    const distance = levenshtein(normalizedInput, target);
    if (distance <= allowedDistance) {
      if (!bestTypo || distance < bestTypo.distance) bestTypo = { kind: 'typo', distance };
    }
  }
  return bestTypo;
}

const V2_KIND_RANK: Record<AnswerMatchKind, number> = {
  exact: 4,
  spaceless: 3,
  wholeWord: 2,
  alias: 2,
  typo: 1,
};

export function matchAnswerV2(input: string, acceptedAnswers: string[]): AnswerMatchResult | null {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return null;

  let best: AnswerMatchResult | null = null;
  for (const acceptedAnswer of acceptedAnswers) {
    const match = matchNormalizedAcceptedAnswerV2(normalizedInput, normalizeAnswer(acceptedAnswer));
    if (!match) continue;
    if (
      !best
      || V2_KIND_RANK[match.kind] > V2_KIND_RANK[best.kind]
      || (V2_KIND_RANK[match.kind] === V2_KIND_RANK[best.kind] && match.distance < best.distance)
    ) {
      best = { kind: match.kind, matchedAnswer: acceptedAnswer, distance: match.distance };
    }
  }
  return best;
}

export function fuzzyMatchesAnswerV2(input: string, acceptedAnswers: string[]): boolean {
  return matchAnswerV2(input, acceptedAnswers) !== null;
}

/**
 * Countdown matching under v2 rules. Same shape as countdownMatch: candidates
 * are ranked by match kind; a guess matching MORE THAN ONE answer group at the
 * same strength is ambiguous and rejected; the prefix fallback is unchanged
 * except that it now respects the whole-word guard (a bare particle can no
 * longer prefix-claim a group).
 */
export function countdownMatchV2(
  evaluation: Extract<MatchQuestionEvaluation, { kind: 'countdown' }>,
  guess: string,
  foundIds: Set<string>
): { id: string; display: Record<string, string> } | null {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return null;

  const candidates: Array<{ id: string; display: Record<string, string>; match: AnswerMatchResult }> = [];
  for (const answerGroup of evaluation.answerGroups) {
    const match = matchAnswerV2(guess, answerGroup.acceptedAnswers);
    if (match) candidates.push({ id: answerGroup.id, display: answerGroup.display, match });
  }

  // exact + spaceless share ONE ambiguity tier: separator removal is an exact
  // equivalence, so a guess exact in group A and spaceless in group B is the
  // same string resolving to two answers — ambiguous, not claimable.
  const kindTiers: AnswerMatchKind[][] = [['exact', 'spaceless'], ['wholeWord'], ['alias'], ['typo']];
  for (const tier of kindTiers) {
    const matchesForTier = candidates.filter((candidate) => tier.includes(candidate.match.kind));
    if (matchesForTier.length > 0) {
      const uniqueGroupIds = new Set(matchesForTier.map((candidate) => candidate.id));
      if (uniqueGroupIds.size !== 1) return null;
      const candidate = matchesForTier[0];
      if (!foundIds.has(candidate.id)) {
        return { id: candidate.id, display: candidate.display };
      }
    }
  }

  if (normalizedGuess.length >= MIN_PREFIX_LENGTH && prefixGuessAllowed(normalizedGuess)) {
    const prefixCandidates: Array<{ id: string; display: Record<string, string> }> = [];
    for (const answerGroup of evaluation.answerGroups) {
      if (hasPrefixMatch(answerGroup.acceptedAnswers, normalizedGuess)) {
        prefixCandidates.push({ id: answerGroup.id, display: answerGroup.display });
      }
    }
    if (prefixCandidates.length === 1) {
      const candidate = prefixCandidates[0];
      if (!foundIds.has(candidate.id)) return candidate;
    }
  }

  return null;
}
