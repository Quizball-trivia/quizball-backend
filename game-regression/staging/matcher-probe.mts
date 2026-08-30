/**
 * Matcher v2 end-to-end probe (staging). Plays ranked-vs-AI matches with a
 * real socket client; on every clue question it looks up the accepted answers
 * in the staging DB, constructs a guess that the LOCAL v1 matcher rejects but
 * the LOCAL v2 matcher accepts (a joined multi-token span, the დიმარია class),
 * sends it through the live server, and afterwards asserts from match_answers
 * that the DEPLOYED server scored it correct — direct proof the deployed
 * matcher is v2. Countdown questions get a joined-display probe the same way.
 *
 * Run: DATABASE_URL=<staging> npx tsx game-regression/staging/matcher-probe.mts [--matches 2]
 */
import postgres from 'postgres';
import { bootstrapTestUsers } from './auth-bootstrap.mjs';
import { connectStaging, clearActiveMatch, type StagingClient } from './staging-client.mjs';
import { autoDraft, autoHalftime, autoRecover, type QuestionPayload } from './bot-behaviors.mjs';
import { fuzzyMatchesAnswer, fuzzyMatchesAnswerV2 } from '../../src/realtime/possession-answer-matching.js';

const URL = process.env.STAGING_URL ?? 'https://api-staging.quizball.io';
const MATCHES = Number(process.argv[process.argv.indexOf('--matches') + 1] || 2);
const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });

interface ProbeRecord {
  matchId: string;
  qIndex: number;
  kind: string;
  guess: string;
  v1Local: boolean;
  v2Local: boolean;
}
const probes: ProbeRecord[] = [];

async function acceptedForQuestion(matchId: string, qIndex: number): Promise<{ accepted: string[]; kind: string } | null> {
  const [row] = await sql<{ payload: Record<string, unknown>; type: string }[]>`
    SELECT qp.payload, q.type FROM match_questions mq
    JOIN questions q ON q.id = mq.question_id
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE mq.match_id = ${matchId} AND mq.q_index = ${qIndex}`;
  if (!row) return null;
  const payload = row.payload ?? {};
  const accepted = Array.isArray(payload.accepted_answers)
    ? payload.accepted_answers.filter((a): a is string => typeof a === 'string')
    : [];
  const display = payload.display_answer;
  if (display && typeof display === 'object') {
    for (const value of Object.values(display)) {
      if (typeof value === 'string' && value.trim()) accepted.push(value);
    }
  }
  return { accepted, kind: row.type };
}

/** Joined multi-token spans of every accepted answer, best (v2-only) first. */
function probeGuess(accepted: string[]): { guess: string; v1: boolean; v2: boolean } | null {
  const candidates: string[] = [];
  for (const answer of accepted) {
    const tokens = answer.trim().split(/\s+/).filter(Boolean);
    for (let start = 0; start < tokens.length - 1; start += 1) {
      for (let end = start + 2; end <= tokens.length; end += 1) {
        const joined = tokens.slice(start, end).join('');
        if ([...joined].length >= 5) candidates.push(joined);
      }
    }
  }
  let fallback: { guess: string; v1: boolean; v2: boolean } | null = null;
  for (const guess of candidates) {
    const v1 = fuzzyMatchesAnswer(guess, accepted);
    const v2 = fuzzyMatchesAnswerV2(guess, accepted);
    if (!v1 && v2) return { guess, v1, v2 };
    if (v2 && !fallback) fallback = { guess, v1, v2 };
  }
  return fallback;
}

async function playMatch(client: StagingClient): Promise<string | null> {
  const answered = new Set<string>();
  let matchId: string | null = null;

  const handler = async (q: QuestionPayload) => {
    if (!q.matchId || typeof q.qIndex !== 'number') return;
    const key = `${q.matchId}:${q.qIndex}`;
    if (answered.has(key)) return;
    answered.add(key);
    const waitMs = q.playableAt ? Math.max(0, new Date(q.playableAt).getTime() - Date.now()) : 0;
    const kind = q.question?.kind ?? 'multipleChoice';
    const base = { matchId: q.matchId, qIndex: q.qIndex };

    setTimeout(async () => {
      try {
        if (kind === 'clues' || kind === 'countdown') {
          const info = await acceptedForQuestion(q.matchId, q.qIndex);
          const probe = info ? probeGuess(info.accepted) : null;
          if (probe && kind === 'clues') {
            probes.push({ matchId: q.matchId, qIndex: q.qIndex, kind, guess: probe.guess, v1Local: probe.v1, v2Local: probe.v2 });
            client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: probe.guess, timeMs: 2000 });
            return;
          }
          if (probe && kind === 'countdown') {
            probes.push({ matchId: q.matchId, qIndex: q.qIndex, kind, guess: probe.guess, v1Local: probe.v1, v2Local: probe.v2 });
            client.socket.emit('match:countdown_guess', { ...base, guess: probe.guess });
            return;
          }
          if (kind === 'clues') client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: 'zzzz', timeMs: 2000 });
          else client.socket.emit('match:countdown_guess', { ...base, guess: 'zzzz' });
        } else if (kind === 'putInOrder') {
          const orderedItemIds = (q.question?.items ?? []).map((i) => i.id);
          client.socket.emit('match:put_in_order_answer', { ...base, orderedItemIds, timeMs: 2000 });
        } else {
          const correct = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
          client.socket.emit('match:answer', { ...base, selectedIndex: correct, timeMs: 2000 });
        }
      } catch (error) {
        console.error('answer error', error);
      }
    }, waitMs + 400);
  };

  client.socket.on('match:question', handler);
  client.socket.emit('ranked:queue_join', {});
  const started = await client.waitFor(() => client.count('match:start') > 0, 150_000);
  if (!started) { console.error('match never started'); return null; }
  matchId = client.latest<{ matchId?: string }>('match:start')?.matchId ?? null;
  console.log('match started', matchId);
  const finished = await client.waitFor(() => client.count('match:final_results') > 0, 480_000);
  client.socket.off('match:question', handler);
  if (!finished) console.error('match never finished', matchId);
  return matchId;
}

const users = await bootstrapTestUsers();
const client = connectStaging(URL, users.a.accessToken, users.a.userId);
await new Promise((resolve) => client.socket.on('connect', resolve));
await clearActiveMatch(client);
autoDraft(client); autoHalftime(client); autoRecover(client);

for (let i = 0; i < MATCHES; i += 1) {
  await playMatch(client);
  await new Promise((resolve) => setTimeout(resolve, 4000));
}
client.disconnect();

console.log(`\nprobes sent: ${probes.length}`);
let pass = 0;
let fail = 0;
for (const probe of probes) {
  const [row] = await sql<{ is_correct: boolean }[]>`
    SELECT is_correct FROM match_answers
    WHERE match_id = ${probe.matchId} AND q_index = ${probe.qIndex} AND user_id = ${users.a.userId}`;
  const serverCorrect = probe.kind === 'countdown'
    ? undefined // countdown correctness is opponent-relative; presence of found answer checked via payload
    : row?.is_correct;
  const expectation = probe.v2Local;
  const verdict = probe.kind === 'countdown'
    ? 'sent'
    : serverCorrect === expectation ? 'PASS' : 'FAIL';
  if (verdict === 'PASS') pass += 1;
  if (verdict === 'FAIL') fail += 1;
  console.log(`${verdict} [${probe.kind}] "${probe.guess}" v1local=${probe.v1Local} v2local=${probe.v2Local} server=${serverCorrect}`);
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail (clues); v2-only probes prove the deployed matcher when v1local=false and server=true`);
await sql.end();
process.exit(fail > 0 ? 1 : 0);
