/**
 * Child process for the two-process WL harness: ticks the orchestrator in a
 * tight loop against the shared DB/Redis until killed or done. Socket
 * emissions go to a sink — the harness asserts on the DB's delivery truth.
 */
import { initRedisClients } from '../../../src/realtime/redis.js';
import { wlRunLockedTick } from '../../../src/modules/weekend-league/wl-orchestrator.js';
import type { QuizballServer } from '../../../src/realtime/socket-server.js';

const sinkIo = {
  to() {
    return { emit() { /* sink */ } };
  },
} as unknown as QuizballServer;

const iterations = Number(process.argv[2] ?? 40);
const intervalMs = Number(process.argv[3] ?? 150);

// Orphan guard: if the parent test process dies (crash, assertion abort)
// this child must NOT keep ticking against the shared DB/Redis — an
// orphaned ticker silently delivers other tests' events into its sink.
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 500).unref();

await initRedisClients();
for (let i = 0; i < iterations; i += 1) {
  try {
    // The PRODUCTION locked entrypoint (strict Redis lock + heartbeat).
    // createWeekly stays off: WL_ORCHESTRATION_ENABLED is false in tests, and
    // the harness only ever owns the tournaments the parent created (the
    // advisory file lock in the parent serializes WL test files).
    await wlRunLockedTick(sinkIo, { createWeekly: false });
  } catch (error) {
    console.error('tick failed', error);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
process.exit(0);
