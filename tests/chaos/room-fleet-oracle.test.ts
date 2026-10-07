import { describe, expect, it } from 'vitest';
import {
  assertLocalUrl,
  assertTarget,
  partyPoints,
  percentile,
  podiumOracle,
  roomPlaces,
} from '../../scripts/chaos/room-fleet-oracle.js';

describe('six-player fleet guard and independent oracle', () => {
  it.each([
    'https://api.quizball.io',
    'https://evil.test',
    'http://127.0.0.1.evil.test',
    'http://localhost.evil.test',
  ])('blocks nonlocal fixture URL %s', (u) => expect(() => assertLocalUrl(u)).toThrow());
  it('does not accept the staging name with a different port or scheme', () => {
    expect(() =>
      assertTarget('http://api-staging.quizball.io', 'staging', 'http://api-staging.quizball.io'),
    ).toThrow();
    expect(() =>
      assertTarget('https://api-staging.quizball.io:444', 'staging', 'https://api-staging.quizball.io:444'),
    ).toThrow();
  });
  it('binds credentials to the API origin', () =>
    expect(() => assertTarget('http://localhost:8050', 'local', 'http://localhost:8040')).toThrow());
  it('allows exact local and staging origins', () => {
    assertTarget('http://127.0.0.1:8050', 'local', 'http://127.0.0.1:8050');
    assertTarget('https://api-staging.quizball.io', 'staging', 'https://api-staging.quizball.io');
  });
  it('six exact ties all score four', () =>
    expect(podiumOracle([10, 10, 10, 10, 10, 10], 10, 0, 0).map((x) => x.points)).toEqual([
      4, 4, 4, 4, 4, 4,
    ]));
  it('competition ranks skip the places occupied by tied players', () =>
    expect(podiumOracle([10, 10, 11, 12, 13, null], 10, 0, 0).map((x) => x.points)).toEqual([
      4, 4, 1, 0, 0, 0,
    ]));
  it('decimal precision and exact window use whole precision units', () =>
    expect(podiumOracle([10.1, 10.2, 10.3, 10.4, 10.5, null], 10.2, 1, 0.1).map((x) => x.points)).toEqual([
      3, 4, 3, 0, 0, 0,
    ]));
  it('no-answer players do not get an exact bonus', () =>
    expect(podiumOracle([0, null, null, null, null, null], 0, 0, 0).map((x) => x.points)).toEqual([
      4, 0, 0, 0, 0, 0,
    ]));
  it('two-player closest baseline remains two points for exact', () =>
    expect(podiumOracle([10, 11], 10, 0, 0).map((x) => x.points)).toEqual([2, 0]));
  it('withdrawn players follow active players even with more points', () =>
    expect(
      roomPlaces([
        { seat: 0, points: 40, wins: 10, error: 0, withdrawn: true },
        { seat: 1, points: 0, wins: 0, error: 10, withdrawn: false },
      ]),
    ).toEqual([2, 1]));
  it('equal final keys share place; wins and error break other ties', () =>
    expect(
      roomPlaces([
        { seat: 0, points: 10, wins: 3, error: 1, withdrawn: false },
        { seat: 1, points: 10, wins: 3, error: 1, withdrawn: false },
        { seat: 2, points: 10, wins: 2, error: 0, withdrawn: false },
        { seat: 3, points: 10, wins: 2, error: 1, withdrawn: false },
      ]),
    ).toEqual([1, 1, 3, 4]));
  it.each([
    [true, 0, 100],
    [true, 500, 100],
    [true, 1500, 90],
    [true, 2500, 80],
    [true, 10000, 10],
    [false, 0, 0],
  ])('party score %s at %s ms', (correct, time, points) =>
    expect(partyPoints(correct as boolean, time as number)).toBe(points),
  );
  it('percentiles use the nearest rank and handle empty samples', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });
});
