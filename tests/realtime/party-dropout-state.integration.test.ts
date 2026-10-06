import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../setup.js';

// Review 2026-10-06 round 5 (#1): a dropout that keeps the match going used to write back the whole state it read
// earlier. If the round closed and the next question opened meanwhile, that restored the old question (the index
// kept moving forward), and answers to the question on screen were refused.
let sql: typeof import('../../src/db/index.js').sql;
let dropout: typeof import('../../src/realtime/services/party-quiz-dropout.service.js');
let matchPlayersRepo: typeof import('../../src/modules/matches/match-players.repo.js').matchPlayersRepo;
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let dbAvailable = false;
let categoryId: string;
const userIds: string[] = [];
const matchIds: string[] = [];

const party = (q: number, dropped: string[] = []) => ({ variant: 'friendly_party_quiz', currentQuestion: { qIndex: q }, droppedUserIds: dropped, answeredUserIds: [] });

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    dropout = await import('../../src/realtime/services/party-quiz-dropout.service.js');
    matchPlayersRepo = (await import('../../src/modules/matches/match-players.repo.js')).matchPlayersRepo;
    matchesService = (await import('../../src/modules/matches/matches.service.js')).matchesService;
    const [cat] = await sql<{ id: string }[]>`
      INSERT INTO categories (name, slug, is_active)
      VALUES (${sql.json({ en: 'IntegrationTest_PartyDropout' })}, ${`integration-test-party-dropout-${randomUUID()}`}, true) RETURNING id`;
    categoryId = cat.id;
  } catch (error) {
    if (dbAvailable) throw error;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (matchIds.length) await sql`DELETE FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
  if (userIds.length) await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
  if (categoryId) await sql`DELETE FROM categories WHERE id = ${categoryId}`;
  await sql.end();
});

describe('Party dropout state write — real database', () => {
  it('a continuing dropout keeps the question opened since it read the match; answers to it still count', async () => {
    if (!dbAvailable) return;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [u] = await sql<{ id: string }[]>`INSERT INTO users (nickname, onboarding_complete) VALUES (${`drop_${randomUUID().slice(0, 8)}`}, true) RETURNING id`;
      ids.push(u.id); userIds.push(u.id);
    }
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, game_variant, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, state_payload)
      VALUES ('friendly', 'active', 'friendly_party_quiz', ${categoryId}, ${categoryId}, 0, 10, false, now(), ${sql.json(party(0))}) RETURNING id`;
    matchIds.push(m.id);
    for (const [seat, userId] of ids.entries()) {
      await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${m.id}, ${userId}, ${seat + 1})`;
    }
    const [match] = await sql`SELECT * FROM matches WHERE id = ${m.id}`;
    // Right after the dropout reads the match, question 0 closes and question 1 opens.
    const original = matchPlayersRepo.listMatchPlayers.bind(matchPlayersRepo);
    vi.spyOn(matchPlayersRepo, 'listMatchPlayers').mockImplementationOnce(async (...args) => {
      await sql`UPDATE matches SET current_q_index = 1, state_payload = ${sql.json(party(1))} WHERE id = ${m.id}`;
      return original(...args);
    });
    const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) };
    const outcome = await dropout.applyPartyQuizDropouts({
      io: io as never, match: match as never, players: [], droppedUserIds: [ids[2]], reason: 'disconnect' as never, resumeIfContinuing: false,
    });
    expect(outcome).toMatchObject({ completed: false });
    const [after] = await sql<{ current_q_index: number; state_payload: { currentQuestion: { qIndex: number } | null; droppedUserIds: string[] } }[]>`
      SELECT current_q_index, state_payload FROM matches WHERE id = ${m.id}`;
    expect(after.current_q_index).toBe(1);
    expect(after.state_payload.currentQuestion?.qIndex).toBe(1);
    expect(after.state_payload.droppedUserIds).toEqual([ids[2]]);
    const answer = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId: m.id, qIndex: 1, userId: ids[0], selectedIndex: 1, isCorrect: true, timeMs: 900, pointsEarned: 50,
    });
    expect(answer.inserted).toBe(true);
  });

  it('PR review (B2): a question dispatch built from an older copy of the state keeps a dropout committed meanwhile', async () => {
    if (!dbAvailable) return;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [u] = await sql<{ id: string }[]>`INSERT INTO users (nickname, onboarding_complete) VALUES (${`disp_${randomUUID().slice(0, 8)}`}, true) RETURNING id`;
      ids.push(u.id); userIds.push(u.id);
    }
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, game_variant, category_a_id, category_b_id, current_q_index, total_questions, is_dev, started_at, state_payload)
      VALUES ('friendly', 'active', 'friendly_party_quiz', ${categoryId}, ${categoryId}, 1, 10, false, now(), ${sql.json({ ...party(0), currentQuestion: null })}) RETURNING id`;
    matchIds.push(m.id);
    const [question] = await sql<{ id: string; category_id: string }[]>`SELECT id, category_id FROM questions LIMIT 1`;
    await sql`INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index) VALUES (${m.id}, 1, ${question.id}, ${question.category_id}, 0)`;
    // The dispatch built its payload before this dropout committed.
    const stale = { ...party(1), droppedUserIds: [] as string[] };
    await sql`UPDATE matches SET state_payload = ${sql.json({ ...party(0), currentQuestion: null, droppedUserIds: [ids[2]] })} WHERE id = ${m.id}`;
    const committed = await matchesService.persistPartyQuestionDispatch({
      matchId: m.id, qIndex: 1, statePayload: stale, shownAt: new Date(), deadlineAt: new Date(Date.now() + 20_000),
    });
    const [after] = await sql<{ state_payload: { currentQuestion: { qIndex: number }; droppedUserIds: string[] } }[]>`SELECT state_payload FROM matches WHERE id = ${m.id}`;
    expect(after.state_payload.currentQuestion.qIndex).toBe(1);
    expect(after.state_payload.droppedUserIds).toEqual([ids[2]]);
    expect(committed).toEqual({ droppedUserIds: [ids[2]] });
    const refused = await matchesService.recordPartyQuizAnswerIfMissing({
      matchId: m.id, qIndex: 1, userId: ids[2], selectedIndex: 0, isCorrect: true, timeMs: 900, pointsEarned: 50,
    });
    expect(refused.roundClosed).toBe(true);
  });
});

