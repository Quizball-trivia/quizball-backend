import { describe, expect, it } from 'vitest';
import { createTrace } from '../../game-regression/src/adapter.mjs';
import { buildClientTruthModel } from '../../game-regression/src/client-model.mjs';
import { halftimeBanStateNeverLost } from '../../game-regression/src/invariants.mjs';

describe('rehearsal client event model', () => {
  const makeTrace = () => createTrace(Date.now);
  it('keeps halftime after the reconnect resume event', () => {
    const trace = makeTrace();
    trace.record('server->room', 'match:question', { matchId: 'm', qIndex: 5 }, 'match:m');
    trace.record('server->room', 'match:pause', { matchId: 'm' }, 'match:m');
    trace.record('server->room', 'match:state', { matchId: 'm', phase: 'HALFTIME' }, 'match:m');
    trace.record('server->room', 'match:resume', { matchId: 'm', nextQIndex: 6 }, 'match:m');
    expect(buildClientTruthModel(trace, { userId: 'u', matchId: 'm' }).stage).toBe('halftime');
  });
  it('recognizes completed authoritative state before the final results payload', () => {
    const trace = makeTrace();
    trace.record('server->room', 'match:state', { matchId: 'm', phase: 'COMPLETED' }, 'match:m');
    expect(buildClientTruthModel(trace, { userId: 'u', matchId: 'm' }).stage).toBe('result');
  });
  it('resumes an ordinary paused question', () => {
    const trace = makeTrace();
    for (const event of ['match:question', 'match:pause', 'match:resume']) {
      trace.record('server->room', event, { matchId: 'm', qIndex: 2 }, 'match:m');
    }
    expect(buildClientTruthModel(trace, { userId: 'u', matchId: 'm' }).stage).toBe('question');
  });
  it('separates the penalty ban stage but catches a lost ban within a stage', () => {
    const trace = makeTrace();
    const add = (half: number, seat1: string | null, seat2: string | null) => trace.record(
      'server->room', 'match:state', { phase: 'HALFTIME', half, halftime: { bans: { seat1, seat2 } } }, 'match:m',
    );
    const context = { matchId: 'm', botUserId: 'u', chaosPlan: { seed: 1, actions: [{ atPhase: 'halftime' as const, kind: 'quitRejoin' as const }] } };
    add(1, 'a', 'b'); add(2, null, null); add(2, 'c', null);
    expect(halftimeBanStateNeverLost(trace, context)).toEqual([]);
    add(2, null, null);
    expect(halftimeBanStateNeverLost(trace, context)).toHaveLength(1);
  });
});
