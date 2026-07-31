/**
 * Child process for the two-process WL harness: ticks the orchestrator in a
 * tight loop against the shared DB/Redis until killed or done. Socket
 * emissions go to a sink — the harness asserts on the DB's delivery truth.
 */
import { initRedisClients } from '../../../src/realtime/redis.js';
import { wlAdvanceOneTournament } from '../../../src/modules/weekend-league/wl-orchestrator.js';
import type { QuizballServer } from '../../../src/realtime/socket-server.js';

const sinkIo = {
  to() {
    return { emit() { /* sink */ } };
  },
} as unknown as QuizballServer;

const tournamentId = process.argv[2] ?? '';
const iterations = Number(process.argv[3] ?? 40);
const intervalMs = Number(process.argv[4] ?? 150);
if (!tournamentId) throw new Error('tournamentId argv required');

await initRedisClients();
for (let i = 0; i < iterations; i += 1) {
  try {
    await wlAdvanceOneTournament(sinkIo, tournamentId);
  } catch (error) {
    console.error('tick failed', error);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
process.exit(0);
