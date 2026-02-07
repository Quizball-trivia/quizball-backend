import { describe, expect, it } from 'vitest';
import '../setup.js';
import {
  deriveSessionStateKind,
  evaluateSessionPolicy,
  type SessionPolicyContext,
} from '../../src/realtime/services/user-session-state.policy.js';

type Scenario = {
  id: string;
  title: string;
  context: SessionPolicyContext;
  expectedState: ReturnType<typeof deriveSessionStateKind>;
  expectedBlockLobbyEntry: boolean;
};

const scenarios: Scenario[] = [
  {
    id: 'S01',
    title: 'stale waiting memberships',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: ['l2', 'l1'], activeLobbyIds: [] },
    expectedState: 'CORRUPT_MULTI_STATE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S02',
    title: 'create while already waiting',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: ['l1'], activeLobbyIds: [] },
    expectedState: 'IN_WAITING_LOBBY',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S03',
    title: 'create or join while active match',
    context: { activeMatchId: 'm1', queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: ['l1'] },
    expectedState: 'IN_ACTIVE_MATCH',
    expectedBlockLobbyEntry: true,
  },
  {
    id: 'S04',
    title: 'orphan active match row',
    context: { activeMatchId: 'm-orphan', queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IN_ACTIVE_MATCH',
    expectedBlockLobbyEntry: true,
  },
  {
    id: 'S05',
    title: 'leave then immediate join race',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S06',
    title: 'double click create or join',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: ['l1'], activeLobbyIds: [] },
    expectedState: 'IN_WAITING_LOBBY',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S07',
    title: 'same user multi tab conflicting actions',
    context: { activeMatchId: null, queueSearchId: 's1', waitingLobbyIds: ['l1'], activeLobbyIds: [] },
    expectedState: 'CORRUPT_MULTI_STATE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S08',
    title: 'lobby deleted during join by code',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S09',
    title: 'host leaves waiting lobby with one member remaining',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S10',
    title: 'both members leave simultaneously',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S11',
    title: 'queue one user then three users',
    context: { activeMatchId: null, queueSearchId: 's1', waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IN_QUEUE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S12',
    title: 'queue blocked but UI stuck searching',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S13',
    title: 'human vs human gets AI fallback answers',
    context: { activeMatchId: 'm1', queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: ['l1'] },
    expectedState: 'IN_ACTIVE_MATCH',
    expectedBlockLobbyEntry: true,
  },
  {
    id: 'S14',
    title: 'answer sync mismatch',
    context: { activeMatchId: 'm1', queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: ['l1'] },
    expectedState: 'IN_ACTIVE_MATCH',
    expectedBlockLobbyEntry: true,
  },
  {
    id: 'S15',
    title: 'player leaves match and opponent pause window',
    context: { activeMatchId: 'm1', queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: ['l1'] },
    expectedState: 'IN_ACTIVE_MATCH',
    expectedBlockLobbyEntry: true,
  },
  {
    id: 'S16',
    title: 'warmup SQL errors should not break lobby control',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: ['l1'], activeLobbyIds: [] },
    expectedState: 'IN_WAITING_LOBBY',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S17',
    title: 'public private toggle not applying',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: ['l1'], activeLobbyIds: [] },
    expectedState: 'IN_WAITING_LOBBY',
    expectedBlockLobbyEntry: false,
  },
  {
    id: 'S18',
    title: 'reconnect result replay consistency',
    context: { activeMatchId: null, queueSearchId: null, waitingLobbyIds: [], activeLobbyIds: [] },
    expectedState: 'IDLE',
    expectedBlockLobbyEntry: false,
  },
];

describe('user-session-state.policy scenario matrix', () => {
  it('derives expected state for all S01-S18 scenarios', () => {
    for (const scenario of scenarios) {
      const decision = evaluateSessionPolicy(scenario.context);
      expect(decision.state, `${scenario.id}: ${scenario.title}`).toBe(scenario.expectedState);
      expect(
        decision.shouldBlockLobbyEntry,
        `${scenario.id}: shouldBlockLobbyEntry`
      ).toBe(scenario.expectedBlockLobbyEntry);
    }
  });

  it('enforces cleanup intents for corrupt multi-state', () => {
    const decision = evaluateSessionPolicy({
      activeMatchId: 'm1',
      queueSearchId: 's1',
      waitingLobbyIds: ['l2', 'l1'],
      activeLobbyIds: ['l1'],
    });

    expect(decision.state).toBe('CORRUPT_MULTI_STATE');
    expect(decision.shouldDropExtraWaitingLobbies).toBe(true);
    expect(decision.shouldDropQueue).toBe(true);
    expect(decision.shouldDropUnrelatedActiveLobbies).toBe(true);
  });
});

