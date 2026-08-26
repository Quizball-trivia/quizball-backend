import { describe, expect, it } from 'vitest';

import {
  evaluateFootballGridLoad,
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
    failureCount: 0,
    rewardMismatches: 0,
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
    fleet.matchesCompleted = 249;
    fleet.clientsCompleted = 498;

    const failures = evaluateFootballGridLoad(fleet, null, noAppTelemetry, 0);
    expect(failures).toEqual(expect.arrayContaining([
      'human matches 248/250',
      'completed matches 249/250',
      'completed clients 498/500',
      'unexpected bot matches 2',
      'invalid pairings self=1 overfilled=0',
    ]));
  });

  it('rejects latency and database pressure beyond the release thresholds', () => {
    const fleet = passingFleet();
    fleet.percentiles.commandAckP95Ms = 1_501;
    fleet.percentiles.commandAckP99Ms = 3_001;

    const failures = evaluateFootballGridLoad(
      fleet,
      {
        total: 80,
        active: 30,
        idle: 49,
        idleInTxn: 1,
        waitingOnLock: 2,
        longestLockWaitSec: 1.1,
        longestActiveSec: 2,
        maxConnections: 100,
        utilizationPct: 80,
      },
      noAppTelemetry,
      0,
    );

    expect(failures).toEqual(expect.arrayContaining([
      'command p95 1501ms > 1500ms',
      'command p99 3001ms > 3000ms',
      'DB connections 80% > 75%',
      'DB lock wait 1.1s > 1s',
      'DB idle-in-transaction 1',
    ]));
  });
});
