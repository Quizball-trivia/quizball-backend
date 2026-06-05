/**
 * LLM trace reviewer — the "second opinion" the user asked for: give a match log
 * to an AI and let it flag what *looks* wrong, beyond the hard-coded invariants.
 *
 * The coded invariants (invariants.mts / party-invariants.mts) catch what we
 * thought to encode. The LLM catches the unknown-unknowns: a player who never got
 * a turn, the same question appearing twice, a halftime with zero questions, a
 * blowout that suggests broken scoring — patterns nobody wrote a rule for.
 *
 * Uses the existing OpenRouter creds (OPENROUTER_API_KEY / OPENROUTER_MODEL, a
 * Gemini flash model) — no new credentials. Self-contained in game-regression/.
 */
import { config } from '../../src/core/config.js';
import type { EventTrace, TraceEvent } from './adapter.mjs';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;

// Judge model. We default to a strong reasoning (Pro) model: it is far more
// reliable at understanding the rulebook and spotting STRUCTURAL bugs (vs flash,
// which is cheap but mis-reads nuanced rules like the penalty/possession logic).
// Override with LLM_JUDGE_MODEL for a different/cheaper judge. The LLM judge is a
// BEST-EFFORT second opinion — the coded invariants are the real, deterministic
// referee; the judge never gates a run on its own.
function judgeModel(): string {
  return process.env.LLM_JUDGE_MODEL || config.OPENROUTER_MODEL || 'google/gemini-3.1-pro-preview';
}
// Cap output so a strong model's default (64k) doesn't trip OpenRouter's
// per-request credit ceiling (a 402). The JSON verdict itself is small, but a
// Pro/thinking model (gemini 3.x pro) spends tokens on internal REASONING before
// emitting the JSON — too low a cap truncates the answer to an empty reply. 8000
// leaves room to reason AND return the verdict; flash judges barely use it.
const JUDGE_MAX_TOKENS = Number(process.env.LLM_JUDGE_MAX_TOKENS ?? 8000);

export interface LlmFinding {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  /** event seq numbers the model cites as evidence, if any. */
  evidenceSeqs?: number[];
}

export interface LlmReview {
  ok: boolean;            // false if the model flagged any high/medium finding
  summary: string;
  findings: LlmFinding[];
  /** raw model text, for debugging. */
  raw?: string;
  /** set when the call itself failed (network/parse) — distinct from "found bugs". */
  error?: string;
}

// The judge must know the RULES and what a CORRECT match looks like, or it will
// flag legal play as bugs and miss real ones. This rulebook is derived from the
// engine (possession-resolution.ts, possession-completion.ts, matches.service.ts).
const SYSTEM_PROMPT = `You are a meticulous QA reviewer for "Quizball", a real-time football quiz game.
You receive the chronological EVENT LOG of ONE automated match (a bot plays the real engine).
First UNDERSTAND THE RULES below, picture the CORRECT match, then flag only DEVIATIONS from it.

=== GAME RULES (possession mode: variant ranked_sim or friendly_possession) ===
- Two seats (seat1, seat2). Questions are answered each round; correctness + speed give POINTS.
- POSSESSION: each round computes delta = seat1Points - seat2Points (using the BARS value
  possessionPointsEarned, which already includes any speed-streak bonus) and adds it to possessionDiff.
  possessionDiff is clamped to [-99, 99]. When it would reach >= +100, seat1 SCORES A GOAL and
  possessionDiff RESETS to 0; when it would reach <= -100, seat2 scores and it resets to 0. So
  possessionDiff resetting to 0 AT a goal is CORRECT, not a bug. goals only ever increase.
- ATOMIC GOAL+RESET (IMPORTANT — DO NOT FLAG): a goal triggers when nextDiff = possessionDiff + delta
  reaches >= 100 (or <= -100), and possessionDiff is reset to 0 IN THE SAME STEP. The client NEVER sees
  possessionDiff sitting at 100 — the threshold-cross and the reset are one atomic event, so a state
  showing possessionDiff=0 right after a goal (even when the prior state was also low/0) is CORRECT. The
  threshold is >= 100 (exactly 100 DOES score). Do NOT flag "diff never visibly reached 100" or
  "goal at exactly 100 vs >100" — that is the intended atomic behaviour.
- BOT PLAYS PERFECTLY (CRITICAL — DO NOT FLAG "possessionDiff stuck at 0"): this is an AUTOMATED test
  bot that answers MAXIMALLY every round, so each round's delta is the full ±100. That means it CROSSES
  the threshold and scores+resets EVERY SINGLE ROUND, so possessionDiff is legitimately 0 in EVERY
  post-round state. A possessionDiff that is 0 in every state while goals climb one-per-round is the
  EXPECTED, CORRECT result of perfect play — it does NOT mean "the accumulation mechanic is bypassed"
  or "diff never moves". With a partial-scoring human the diff WOULD accumulate; the bot just never
  leaves a remainder. Do NOT flag "possessionDiff never accumulates / stays 0 / instant goal per round".
- HALFTIME RESET (IMPORTANT — DO NOT FLAG): possessionDiff is INTENTIONALLY reset to 0 at the start
  of the 2nd half (beginSecondHalf), along with the speed-streak and kickoff. Possession does NOT
  carry across the half boundary. A possessionDiff going from any value to 0 at the HALFTIME->2nd-half
  NORMAL_PLAY transition is CORRECT BY DESIGN, never a bug.
- LAST_ATTACK (IMPORTANT — DO NOT FLAG): an optional bonus attack near a half boundary with its OWN
  scoring rules — an attacker can score a goal WITHOUT the possessionDiff reaching ±100 (it is a direct
  shot, not possession accumulation). Its phaseRound value is a separate bonus index and may look
  unrelated to the normal 1..6 count. Do NOT flag a LAST_ATTACK goal "below the 100 threshold" or its
  phaseRound value as inconsistent.
- SPEED-STREAK (IMPORTANT — DO NOT FLAG): a round_result shows pointsEarned (the SCORE) and
  possessionPointsEarned (the BARS). When a speed-streak bonus fires, BARS = 2 x SCORE while the
  SCORE stays single (e.g. score 80, bars 160). This is CORRECT — the score is NOT doubled, only the
  bars are. score != bars is EXPECTED whenever bars = 2x score. Possession uses the BARS value.
- A match has 2 halves, 6 normal questions per half (12 normal total). qIndex is a GLOBAL counter
  that ALSO includes last_attack/penalty bonus rounds, so a global qIndex > 12 can be legal.
  The per-half normal counter is "phaseRound" (1..6); phaseRound must never exceed total(=12 overall view).
- PHASES and the only LEGAL transitions:
    NORMAL_PLAY -> NORMAL_PLAY | LAST_ATTACK | HALFTIME | COMPLETED
    LAST_ATTACK -> LAST_ATTACK | HALFTIME | NORMAL_PLAY | COMPLETED
    HALFTIME    -> NORMAL_PLAY (2nd half) | PENALTY_SHOOTOUT | COMPLETED
    PENALTY_SHOOTOUT -> PENALTY_SHOOTOUT | COMPLETED
  HALFTIME happens at the half boundary; it has a category-ban interlude (halftime_ban) and
  dispatches NO normal questions while in HALFTIME. PENALTY_SHOOTOUT is reached ONLY from HALFTIME
  (a 2nd-half DRAW routes through a halftime-style ban interlude into penalties) — NEVER directly
  from NORMAL_PLAY/LAST_ATTACK. LAST_ATTACK is an optional bonus attack near a half boundary.
- PENALTY SHOOTOUT scoring (IMPORTANT — answering correctly is NOT a goal): each penalty round has
  exactly ONE shooter (seats ALTERNATE: seat1 shoots, then seat2, etc.). The OTHER seat is the keeper.
  A penalty GOAL is scored ONLY by the shooter, and ONLY if (shooter correct AND keeper WRONG) OR
  (both correct AND shooter answered faster). A correct keeper answer is a SAVE (no goal). So a player
  answering many penalty questions correctly can legitimately have FEW or ZERO penalty goals — most of
  their correct answers were as the KEEPER (saves), not as the shooter. Do NOT assume correct = goal in
  penalties. Penalty phaseRound repeating per shot-pair is normal. Only flag a penalty goal that is
  impossible given the shooter/keeper rule (e.g. a goal credited to the keeper, or to a shooter who
  answered wrong while the keeper answered correct).
- PENALTY SCORE LIVES IN penaltyGoals, NOT goals (CRITICAL — read the right field): during
  PENALTY_SHOOTOUT the open-play 'goals' field is FROZEN at the regulation score (e.g. 3-3) — penalties
  do NOT change it. The shootout's live score is the SEPARATE 'penaltyGoals' field (and 'kicks'/attempts
  show each shot as goal/miss). To judge whether penalties are "incrementing", look ONLY at
  penaltyGoals/kicks in the state line — NEVER conclude "penalty goals not incrementing" from the
  frozen goals=3-3. Each penalty round_result also prints "penalty=goal(seatN)" / "penalty=saved".
- PENALTY TERMINATION & SUDDEN DEATH: best-of-5 per side. The shootout ENDS (-> COMPLETED) as soon as
  one side's lead is unbeatable (the other can't catch up in their remaining kicks), or after 5 kicks
  each if one leads. If tied 5-5 it enters SUDDEN DEATH (suddenDeath=true): one pair at a time, ends
  when one scores and the other misses in the same pair. A shootout that is STILL TIED after few kicks
  (e.g. 2-2 after 3 and 2 kicks) is CORRECTLY still going — that is NOT a stall. Because this bot
  answers perfectly, BOTH sides tend to score every shot, so a bot-vs-bot shootout can run MANY rounds
  (5-5 then long sudden death) before resolving — a long-but-PROGRESSING shootout (kicks/penaltyGoals
  advancing each round) is EXPECTED, not a bug. ONLY flag a TRUE stall: penaltyGoals AND kicks NOT
  advancing across rounds, or a met win-condition that did NOT transition to COMPLETED.
- WIN DECISION (in order): more GOALS wins (method 'goals'); if goals tie, more PENALTY goals wins
  (method 'penalty_goals'); only if still tied, higher total POINTS decides (method 'total_points').
  So the FINAL winner may legitimately have FEWER total points than the loser if they had more goals.
- SCORE vs BARS: a round_result shows pointsEarned (score) and possessionPointsEarned (bars). They are
  equal, OR bars = 2x score when a speed-streak bonus fired. Any OTHER ratio is suspect.
- Question kinds: multipleChoice, countdown, putInOrder, clues. The bot answers MCQ; specials may
  resolve on a (collapsed) timeout — that is NORMAL.

=== PARTY mode (variant friendly_party_quiz) ===
- 2-6 players, MCQ only, everyone answers simultaneously. There are NO possession bars/goals/phases —
  instead party_state shows a leaderboard: each player's totalPoints (only ever increases), rank, and
  rankingOrder sorted by points desc; leaderUserId must be rankingOrder[0]. Final standings rank 1..N.

=== WHAT A CORRECT MATCH LOOKS LIKE (happy path) ===
- MATCH START, then a sequence of question -> round_result per qIndex (each qIndex appears ONCE unless
  a RESUME re-dispatches it), scores/possession evolving by the rules above, legal phase transitions,
  ending in exactly one FINAL with a winner consistent with the decision rules (or a draw only in
  party / pre-penalty states). Each player gets turns; the match terminates.

=== DO NOT FLAG (these are NORMAL) ===
- Tiny/zero durations or fast pacing (this run uses COLLAPSED timers).
- possessionDiff resetting to 0 exactly when a goal is scored.
- possessionDiff resetting to 0 at the HALFTIME -> 2nd-half transition (intended; see HALFTIME RESET).
- score != bars when bars = 2x score (the speed-streak bonus; see SPEED-STREAK).
- Two consecutive match:start events at the very start — these are the per-player emits (one per seat),
  not a duplicate. Likewise two consecutive identical match:state emits are a normal re-emit.
- The penalty shootout using its own phaseRound counter (resetting/incrementing differently from
  normal play) — penalties are scored separately.
- A lopsided but legal scoreline; the AI answering quickly; specials timing out.
- The winner having fewer total points than the loser IF they had more goals (method 'goals').
- A global qIndex above 12 when last_attack/penalty rounds occurred.

=== DO FLAG (real bugs) ===
- The same qIndex dispatched twice with NO intervening RESUME; a question after FINAL/COMPLETED.
- goals or a player's points DECREASING; possessionDiff jumping in a way the delta rule can't explain.
- An ILLEGAL phase transition (per the list above), e.g. NORMAL_PLAY -> PENALTY_SHOOTOUT directly,
  or HALFTIME dispatching normal questions.
- The declared FINAL winner contradicting the decision rules (e.g. fewer goals but declared winner).
- A player who never answers / a match that never reaches FINAL; a round resolving with impossible data.
- Party: a player's score going down, leaderboard not sorted, leader != rankingOrder[0], ranks not 1..N.

Respond ONLY as JSON: {"summary": string, "findings": [{"severity":"high|medium|low","title":string,"detail":string,"evidenceSeqs":[number]}]}.
Cite the relevant event "seq" numbers in evidenceSeqs. If the match looks correct, return an empty findings array.`;

/** Compact one event into a single readable log line. */
function lineFor(e: TraceEvent): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const q = typeof p.qIndex === 'number' ? ` q${p.qIndex}` : '';
  switch (e.event) {
    case 'match:start': return `${e.seq}: MATCH START variant=${p.variant ?? '?'}`;
    case 'match:question': {
      const kind = (p.question as { kind?: string } | undefined)?.kind ?? '?';
      return `${e.seq}: question${q} kind=${kind} phaseRound=${p.phaseRound ?? '?'}/${p.total ?? '?'} phaseKind=${p.phaseKind ?? 'normal'}`;
    }
    case 'match:round_result': {
      const players = p.players as Record<string, { pointsEarned?: number; possessionPointsEarned?: number }> | undefined;
      const scores = players ? Object.entries(players).map(([u, v]) => `${u.slice(0, 4)}:+${v.pointsEarned ?? 0}/bars+${v.possessionPointsEarned ?? 0}`).join(' ') : '';
      // Surface the penalty outcome so the judge can see WHO scored a PENALTY goal
      // (separate from open-play goals). Without this it can't tell a shootout is
      // progressing and wrongly flags "penalty goals not incrementing".
      const d = p.deltas as { penaltyOutcome?: string; goalScoredBySeat?: number } | undefined;
      const pen = d?.penaltyOutcome ? ` penalty=${d.penaltyOutcome}${d.goalScoredBySeat ? `(seat${d.goalScoredBySeat})` : ''}` : '';
      return `${e.seq}: round_result${q} ${scores}${pen}`;
    }
    case 'match:state': {
      // In a shootout, the open-play `goals` field is FROZEN (it's regulation
      // score); the live score is `penaltyGoals`. Show both + sudden-death so the
      // judge tracks the shootout's actual progress, not the frozen goals.
      const base = `${e.seq}: state phase=${p.phase ?? '?'} half=${p.half ?? '?'} possDiff=${p.possessionDiff ?? '?'} goals=${JSON.stringify(p.goals ?? {})}`;
      if (p.phase === 'PENALTY_SHOOTOUT') {
        return `${base} penaltyGoals=${JSON.stringify(p.penaltyGoals ?? {})} kicks=${JSON.stringify(p.penaltyAttempts ?? {})} suddenDeath=${p.penaltySuddenDeath ?? false}`;
      }
      return base;
    }
    case 'match:party_state': {
      const players = p.players as Array<{ userId: string; totalPoints: number; rank: number }> | undefined;
      const board = players ? players.map((pl) => `${pl.userId.slice(0, 4)}#${pl.rank}=${pl.totalPoints}`).join(' ') : '';
      return `${e.seq}: party_state leader=${String(p.leaderUserId ?? '').slice(0, 4)} ${board}`;
    }
    case 'match:resume': return `${e.seq}: RESUME nextQ=${p.nextQIndex ?? '?'}`;
    case 'match:final_results': return `${e.seq}: FINAL winner=${String(p.winnerId ?? 'DRAW').slice(0, 4)} method=${p.winnerDecisionMethod ?? '?'} players=${JSON.stringify(p.players ?? {})}`;
    case 'match:opponent_disconnected': return `${e.seq}: opponent_disconnected`;
    case 'match:halftime_ban': return `${e.seq}: halftime_ban`;
    default: return null; // skip acks/noise
  }
}

/** Turn a trace into a compact human/LLM-readable timeline (room events only). */
export function serializeTrace(trace: EventTrace): string {
  const lines: string[] = [];
  for (const e of trace.events) {
    // Skip per-socket acks; keep the meaningful room-level + lifecycle events.
    if (e.dir === 'server->socket' && e.event !== 'match:rejoin_available') continue;
    const line = lineFor(e);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function parseReview(content: string): LlmReview {
  try {
    const parsed = JSON.parse(content) as { summary?: string; findings?: LlmFinding[] };
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const ok = !findings.some((f) => f.severity === 'high' || f.severity === 'medium');
    return { ok, summary: parsed.summary ?? '', findings, raw: content };
  } catch {
    return { ok: true, summary: 'unparseable model response', findings: [], raw: content, error: 'parse_failed' };
  }
}

/**
 * Send a trace to the LLM for review, SAMPLED N times (default 3) and UNIONed:
 * the flash judge is non-deterministic and sometimes returns a blank/clean reply
 * for a genuinely buggy trace, so a single call can't be trusted not to miss a bug.
 * We take the union of findings across samples (deduped by title) — a real bug only
 * needs to be caught by ONE sample. Fails OPEN (ok:true) on pure API failure so the
 * reviewer never blocks the fuzzer or reddens a clean run on a hiccup.
 */
export async function reviewTrace(
  trace: EventTrace,
  context?: { variant?: string; note?: string; samples?: number },
): Promise<LlmReview> {
  const apiKey = config.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ok: true, summary: 'LLM review skipped (no OPENROUTER_API_KEY)', findings: [], error: 'no_api_key' };
  }
  // 5 samples: the flash judge is individually flaky (sometimes returns a clean
  // verdict for a buggy trace), but unioning 5 independent samples reliably surfaces
  // a real bug — validated against crafted buggy/clean traces. Override per-call.
  const samples = Math.max(1, context?.samples ?? 5);
  const results = await Promise.all(
    Array.from({ length: samples }, () => reviewTraceOnce(apiKey, trace, context)),
  );

  // Union findings across samples, deduped by lowercased title; keep highest severity.
  const sevRank = { high: 3, medium: 2, low: 1 } as const;
  const byTitle = new Map<string, LlmFinding>();
  for (const r of results) {
    for (const f of r.findings) {
      const key = f.title.trim().toLowerCase();
      const existing = byTitle.get(key);
      if (!existing || sevRank[f.severity] > sevRank[existing.severity]) byTitle.set(key, f);
    }
  }
  const findings = [...byTitle.values()];
  const anyReal = findings.some((f) => f.severity === 'high' || f.severity === 'medium');
  const allErrored = results.every((r) => r.error);
  return {
    ok: !anyReal,
    summary: results.find((r) => r.summary && !r.error)?.summary
      ?? (allErrored ? 'LLM review unavailable' : `Reviewed in ${samples} samples; ${findings.length} unique finding(s).`),
    findings,
    ...(allErrored ? { error: results[0]?.error } : {}),
  };
}

/** A single review call (with one retry on empty/HTTP error). */
async function reviewTraceOnce(
  apiKey: string,
  trace: EventTrace,
  context?: { variant?: string; note?: string },
): Promise<LlmReview> {
  const timeline = serializeTrace(trace);
  const userMessage = [
    context?.variant ? `Variant: ${context.variant}` : '',
    context?.note ? `Note: ${context.note}` : '',
    'EVENT LOG:',
    timeline,
  ].filter(Boolean).join('\n');

  // The flash model occasionally returns an empty completion. A blank response
  // must NOT read as "clean" (that would silently miss bugs), so retry once on an
  // empty/unparseable body before giving up.
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://quizball.app',
        },
        body: JSON.stringify({
          model: judgeModel(),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: JUDGE_MAX_TOKENS,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        lastError = `http_${response.status}: ${errorText.slice(0, 200)}`;
        continue; // retry once
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = (data.choices?.[0]?.message?.content ?? '').trim();
      if (!content) { lastError = 'empty_completion'; continue; } // retry once
      return parseReview(content);
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error.message : 'unknown';
    }
  }
  return { ok: true, summary: 'LLM review unavailable', findings: [], error: lastError || 'unknown' };
}

/** One-line-per-finding formatter for reports. */
export function formatLlmFinding(f: LlmFinding): string {
  const ev = f.evidenceSeqs?.length ? ` @[${f.evidenceSeqs.join(',')}]` : '';
  return `[LLM:${f.severity}] ${f.title}${ev} — ${f.detail}`;
}

export type { TraceEvent };
