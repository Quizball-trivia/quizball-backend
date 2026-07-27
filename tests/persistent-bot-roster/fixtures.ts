import type { RosterPatterns } from '../../scripts/persistent-bot-roster/patterns.js';

/**
 * A synthetic patterns.json fixture for unit tests — independent of live data so
 * the tests are deterministic and hermetic. Structurally identical to what
 * measure.ts emits.
 */
export function makePatterns(overrides: Partial<RosterPatterns> = {}): RosterPatterns {
  const base: RosterPatterns = {
    schemaVersion: 1,
    generatedAt: '2026-07-27T00:00:00.000Z',
    measuredAgainst: 'test',
    cohort: { realWithIdentity: 11245, namedUsers: 152, namedAndPlayed: 122, everPlayed: 6190 },
    exclusion: { count: 0, sha256: 'test', names: [] },
    name: {
      cohortSize: 122,
      namedCohortSize: 152,
      singleWordRate: 0.625,
      twoWordRate: 0.375,
      digitRate: 0.105,
      separators: { underscore: 0.007, dot: 0.013, dash: 0, space: 0.375 },
      casing: { allLower: 0.336, allUpper: 0.033, titleCase: 0.59 },
      georgianScriptRate: 0.013,
      trailingDigitTokens: [
        { value: '14', weight: 2 },
        { value: '23', weight: 2 },
        { value: '09', weight: 1 },
        { value: '69', weight: 1 },
        { value: '7', weight: 1 },
      ],
    },
    avatar: {
      source: 'overridden',
      presenceRate: 0.08,
      hair: [
        { value: 'hair_boy_basic', weight: 35 },
        { value: 'hair_ramos', weight: 8 },
        { value: 'hair_hamsik', weight: 8 },
      ],
      jersey: [
        { value: 'jersey_blue', weight: 22 },
        { value: 'jersey_red', weight: 17 },
        { value: 'jersey_green', weight: 15 },
      ],
      skin: [
        { value: 'skin_male_white', weight: 83 },
        { value: 'skin_male_dark_alt', weight: 1 },
      ],
      facialHairRate: 0.06,
      facialHair: [{ value: 'stache', weight: 3 }, { value: 'beard', weight: 2 }],
      glassesRate: 0.06,
      glasses: [{ value: 'glasses_aviator', weight: 4 }],
      rawHairMeasured: [{ value: 'hair_boy_basic', weight: 78 }],
    },
    country: {
      source: 'overridden',
      rationale: 'test override',
      distribution: [
        { value: 'GE', weight: 85 },
        { value: 'US', weight: 3 },
        { value: 'GB', weight: 3 },
        { value: 'TR', weight: 2 },
        { value: 'GR', weight: 2 },
        { value: 'DE', weight: 2 },
        { value: 'ES', weight: 3 },
      ],
      rawMeasured: [{ value: 'FI', weight: 10863 }, { value: 'GE', weight: 297 }],
      cities: [],
    },
    club: {
      source: 'measured',
      nonNullRate: 0.0085,
      distribution: [
        { value: 'FC Barcelona', weight: 19 },
        { value: 'Real Madrid', weight: 12 },
        { value: 'Dinamo Tbilisi', weight: 4 },
      ],
    },
    activity: {
      source: 'overridden',
      usersClustered: 6091,
      hourlyHistogram: [
        5872, 700, 4072, 1802, 989, 977, 2998, 1066, 0, 101, 106, 112,
        1692, 2018, 4819, 2192, 3007, 2350, 4394, 6017, 1007, 1660, 2254, 2892,
      ],
      scheduleArchetypes: [
        { key: 'evening', weight: 55, startHour: 17, endHour: 25.38, sessionLength: [1, 3], dailyCapQuantiles: [[0.5, 2], [0.75, 4], [0.9, 8], [0.99, 12], [1.0, 20]] },
        { key: 'daytime', weight: 30, startHour: 11, endHour: 17, sessionLength: [1, 4], dailyCapQuantiles: [[0.5, 2], [0.75, 3], [0.9, 6], [0.99, 12], [1.0, 21]] },
        { key: 'morning', weight: 12, startHour: 7, endHour: 11, sessionLength: [1, 2], dailyCapQuantiles: [[0.5, 2], [0.75, 3], [0.9, 5], [0.99, 8], [1.0, 10]] },
        { key: 'night_owl', weight: 3, startHour: 0, endHour: 5, sessionLength: [1, 2], dailyCapQuantiles: [[0.5, 2], [0.75, 3], [0.9, 5], [0.99, 8], [1.0, 8]] },
      ],
    },
    categorySlugs: [
      'world-cup', 'premier-league', 'la-liga', 'seria-a', 'bundes-liga', 'transfers',
      'ballon-dor', 'champios-leage', 'arsenal', 'barcelona', 'real-madrid', 'juventus',
      'argentina', 'brazil', 'england', 'france', 'germany', 'portugal',
    ],
    rename: { source: 'overridden', lifetimeRate: 0.12, rawMeasuredRate: 0.0002 },
    skill: {
      bandWeights: [20, 30, 30, 15, 5],
      bandRanges: [
        [0.05, 0.25],
        [0.25, 0.45],
        [0.45, 0.6],
        [0.6, 0.75],
        [0.75, 0.9],
      ],
    },
  };
  return { ...base, ...overrides };
}
