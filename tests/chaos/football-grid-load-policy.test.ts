import { describe, expect, it } from 'vitest';

import {
  evaluateFootballGridLoad,
  footballGridRewardMismatch,
  isRecoverableGridDisconnect,
  type GridFleetSummary,
} from '../../scripts/chaos/football-grid.js';
import type { AppStatsSummary } from '../../scripts/chaos/app-stats.js';

function passingFleet(): GridFleetSummary {
  return {
    clients: 500,
    expectedMatches: 250,
    connectedClients: 500,
    searchesStarted: 500,
    clientsMatched: 500,
    uniqueMatchesFound: 250,
    humanMatchesFound: 250,
    unexpectedBotMatches: 0,
    selfPairings: 0,
    overfilledMatches: 0,
    matchesStarted: 250,
    matchesCompleted: 250,
    completionAcksSent: 500,
    clientsCompleted: 500,
    commandResults: 10_000,
    wrongAnswers: 10_000,
    socketErrors: 0,
    connectionErrors: 0,
    disconnectsBeforeCompletion: 0,
    recoveredDisconnects: 0,
    unrecoverableDisconnects: 0,
    failureCount: 0,
    rewardMismatches: 0,
    rewardMismatchReasons: {},
    completionReasons: { turn_limit: 500 },
    errors: {},
    percentiles: {
      searchToFoundP50Ms: 300,
      searchToFoundP95Ms: 1_000,
      searchToFoundP99Ms: 2_000,
      commandAckP50Ms: 100,
      commandAckP95Ms: 400,
      commandAckP99Ms: 800,
      matchDurationP50Ms: 8_000,
      matchDurationP95Ms: 12_000,
      matchDurationP99Ms: 15_000,
    },
  };
}

const noAppTelemetry: AppStatsSummary = {
  intervalMs: 1_000,
  requestFailures: 0,
  instances: {},
};

describe('Football Tic Tac Toe load-gate policy', () => {
  it('accepts an exact 500-client/250-human-match run', () => {
    expect(evaluateFootballGridLoad(passingFleet(), null, noAppTelemetry, 0)).toEqual([]);
  });

  it('rejects bot fallback, invalid pairing, and incomplete results', () => {
    const fleet = passingFleet();
    fleet.humanMatchesFound = 248;
    fleet.unexpectedBotMatches = 2;
    fleet.selfPairings = 1;
    fleet.matchesCompleted = 247;
    fleet.clientsCompleted = 494;

    const failures = evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0);
    expect(failures).toEqual(expect.arrayContaining([
      'human matches 248/250',
      'completed matches 247/250',
      'completed clients 494/500',
      'unexpected bot matches 2',
      'invalid pairings self=1 overfilled=0',
    ]));
  });

  it('allows at most two incomplete matches and four client timeouts at the 500-client gate', () => {
    const fleet = passingFleet();
    fleet.matchesCompleted = 248;
    fleet.clientsCompleted = 496;
    fleet.completionAcksSent = 496;
    fleet.failureCount = 4;
    fleet.errors = { client_timeout: 4 };

    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0)).toEqual([]);

    fleet.matchesCompleted = 247;
    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0)).toContain('completed matches 247/250');
  });

  it('allows fewer than five STALE_STATE errors but rejects the fifth', () => {
    const fleet = passingFleet();
    fleet.socketErrors = 4;
    fleet.failureCount = 4;
    fleet.errors = { 'grid_error:STALE_STATE': 4 };
    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0)).toEqual([]);

    fleet.socketErrors = 5;
    fleet.failureCount = 5;
    fleet.errors = { 'grid_error:STALE_STATE': 5 };
    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0)).toContain('STALE_STATE errors 5 >= 5');
  });

  it('allows recovered transport churn but rejects an unrecoverable disconnect', () => {
    const fleet = passingFleet();
    fleet.disconnectsBeforeCompletion = 212;
    fleet.recoveredDisconnects = 212;
    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0)).toEqual([]);

    fleet.unrecoverableDisconnects = 1;
    expect(evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0))
      .toContain('transport failures socket=0 connect=0 transient=212 recovered=212 unrecoverable=1 clients=0');
  });

  it('only retries disconnect reasons Socket.IO marks as recoverable', () => {
    expect(isRecoverableGridDisconnect('transport close', true)).toBe(true);
    expect(isRecoverableGridDisconnect('ping timeout', true)).toBe(true);
    expect(isRecoverableGridDisconnect('io server disconnect', false)).toBe(false);
    expect(isRecoverableGridDisconnect('io client disconnect', false)).toBe(false);
  });

  it('rejects latency and database pressure beyond the release thresholds', () => {
    const fleet = passingFleet();
    fleet.percentiles.searchToFoundP50Ms = 5_000;
    fleet.percentiles.commandAckP95Ms = 1_501;
    fleet.percentiles.commandAckP99Ms = 3_001;

    const failures = evaluateFootballGridLoad(
      fleet,
      {
        total: 80,
        active: 30,
        idle: 49,
        idleInTxn: 1,
        longestIdleInTxnSec: 1.1,
        waitingOnLock: 2,
        longestLockWaitSec: 1.1,
        longestActiveSec: 2,
        maxConnections: 100,
        utilizationPct: 95,
      },
      noAppTelemetry,
      0,
    );

    expect(failures).toEqual(expect.arrayContaining([
      'search p50 5000ms >= 5000ms',
      'command p95 1501ms > 1500ms',
      'command p99 3001ms > 3000ms',
      'DB connections 95% >= 95%',
      'DB lock wait 1.1s > 1s',
      'DB idle-in-transaction 1.1s > 1s',
    ]));
  });

  it('verifies normal, no-contest, and forfeit reward policy without hiding disabled normal rewards', () => {
    const expected = { xp: 60, tp: 30, coins: 250 };
    expect(footballGridRewardMismatch({
      userId: 'u1',
      state: { completionReason: 'turn_limit', winnerUserId: null },
      rewards: { xp: 60, tp: 30, coins: 250, coinEligibilityReason: 'eligible', tpEligibilityReason: 'eligible' },
      expected,
    })).toBeNull();
    expect(footballGridRewardMismatch({
      userId: 'u1',
      state: { completionReason: 'simultaneous_disconnect', winnerUserId: null },
      rewards: { xp: 0, tp: 0, coins: 0, coinEligibilityReason: 'no_contest', tpEligibilityReason: 'no_contest' },
      expected,
    })).toBeNull();
    expect(footballGridRewardMismatch({
      userId: 'winner',
      state: { completionReason: 'disconnect_timeout', winnerUserId: 'winner' },
      rewards: { xp: 70, tp: 0, coins: 0, coinEligibilityReason: 'forfeit_no_coins', tpEligibilityReason: 'forfeit_no_points' },
      expected,
    })).toBeNull();
    expect(footballGridRewardMismatch({
      userId: 'loser',
      state: { completionReason: 'disconnect_timeout', winnerUserId: 'winner' },
      rewards: { xp: 20, tp: 0, coins: 0, coinEligibilityReason: 'forfeit_no_coins', tpEligibilityReason: 'forfeit_no_points' },
      expected,
    })).toBeNull();
    expect(footballGridRewardMismatch({
      userId: 'u1',
      state: { completionReason: 'turn_limit', winnerUserId: null },
      rewards: { xp: 60, tp: 0, coins: 0, coinEligibilityReason: 'coins_disabled', tpEligibilityReason: 'points_disabled' },
      expected,
    })).toContain('turn_limit:expected_60_30_250');
  });

  it('allows short transaction gaps that are gone before they can become stuck', () => {
    expect(evaluateFootballGridLoad(
      passingFleet(),
      {
        total: 20,
        active: 5,
        idle: 10,
        idleInTxn: 5,
        longestIdleInTxnSec: 0.2,
        waitingOnLock: 0,
        longestLockWaitSec: 0,
        longestActiveSec: 0.3,
        maxConnections: 60,
        utilizationPct: 33.3,
      },
      noAppTelemetry,
      0,
    )).toEqual([]);
  });
});
