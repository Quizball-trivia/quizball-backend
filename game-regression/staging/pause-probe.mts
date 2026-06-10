/**
 * Direct pause/resume probe against staging (investigation tool, not a scenario):
 * start a ranked-AI match, answer until 2 rounds resolve, then HARD-disconnect and
 * stay gone ~10s (a real network loss, not a reload). Expect the server to pause
 * (match:opponent_disconnected to the AI side is unobservable here, but the pause
 * shows in server logs) and on reconnect expect rejoin + resume countdown.
 */
import { bootstrapTestUsers, type TestUser } from './auth-bootstrap.mjs';
import { connectStaging, clearActiveMatch, type StagingClient } from './staging-client.mjs';

const URL = process.env.STAGING_URL ?? 'https://api-staging.quizball.io';

function autoAnswer(client: StagingClient): void {
  client.socket.on('match:question', (q: { matchId: string; qIndex: number; question: { kind: string; options?: unknown[] }; correctIndex?: number }) => {
    setTimeout(() => {
      if (q.question.kind === 'multipleChoice') {
        client.socket.emit('match:answer', { matchId: q.matchId, qIndex: q.qIndex, answerIndex: q.correctIndex ?? 0, timeMs: 1500 });
      }
    }, 700);
  });
  client.socket.on('draft:start', (d: { lobbyId: string; options?: Array<{ id: string }> }) => {
    setTimeout(() => {
      const first = d.options?.[0]?.id;
      if (first) client.socket.emit('draft:ban', { lobbyId: d.lobbyId, categoryId: first });
    }, 800);
  });
}

async function main(): Promise<void> {
  const users = await bootstrapTestUsers();
  const a: TestUser = users.a;
  const client = connectStaging(URL, a.accessToken, a.userId);
  await client.waitFor(() => client.socket.connected, 15_000);
  await clearActiveMatch(client);
  autoAnswer(client);

  console.log(`[probe] user=${a.userId} queueing…`);
  client.socket.emit('ranked:queue_join', {});
  const started = await client.waitFor(() => client.count('match:start') > 0 && client.count('match:question') > 0, 90_000);
  if (!started) { console.log('[probe] FAIL: match never started'); process.exit(1); }
  const matchId = client.latest<{ matchId: string }>('match:start')!.matchId;
  console.log(`[probe] match ${matchId} started; playing 2 rounds…`);
  await client.waitFor(() => client.count('match:round_result') >= 2, 90_000);

  console.log(`[probe] HARD DISCONNECT at ${new Date().toISOString()} — staying gone 10s`);
  client.socket.disconnect();
  await new Promise((r) => setTimeout(r, 10_000));

  console.log(`[probe] reconnecting at ${new Date().toISOString()}`);
  const rejoined = connectStaging(URL, a.accessToken, a.userId, client.trace);
  autoAnswer(rejoined);
  await rejoined.waitFor(() => rejoined.socket.connected, 15_000);
  rejoined.socket.emit('match:rejoin', { matchId });

  const resumed = await rejoined.waitFor(
    () => client.count('match:resume') > 0 || client.count('match:countdown') > 0,
    20_000
  );
  console.log(`[probe] resume/countdown observed: ${resumed}`);
  console.log(`[probe] events: resume=${client.count('match:resume')} countdown=${client.count('match:countdown')} rejoin_available=${client.count('match:rejoin_available')} question=${client.count('match:question')}`);
  // Don't wait for full completion; clean up.
  rejoined.socket.emit('match:forfeit', { matchId });
  await new Promise((r) => setTimeout(r, 3_000));
  rejoined.disconnect();
  process.exit(0);
}

main().catch((error) => { console.error('[probe] error', error); process.exit(1); });
