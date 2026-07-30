/**
 * Shape of patterns.json — the measured real-user distribution the generator
 * consumes. Produced by measure.ts (read-only against staging/prod), checked in
 * for reproducibility, and regeneratable.
 *
 * Fields carry a `source` discriminator so the dry-run report can visibly label
 * every distribution as either MEASURED (mimics real data) or OVERRIDDEN (a
 * deliberate design decision that diverges from a contaminated/artifact signal —
 * e.g. geoip-defaulted country, default-hair avatars). A reviewer approving the
 * report's sha256 is attesting to the OVERRIDDEN decisions, so they must be
 * explicit, never buried.
 */

export type DistributionSource = 'measured' | 'overridden';

export interface WeightedString {
  value: string;
  weight: number;
}

export interface NameStructurePatterns {
  /** Sample size the structural rates were measured over (named+played cohort). */
  cohortSize: number;
  /** Secondary cohort size (all named users), reported for context. */
  namedCohortSize: number;
  /** P(single-word name) vs P(two-word first+last). */
  singleWordRate: number;
  twoWordRate: number;
  /** P(name contains a digit). */
  digitRate: number;
  /** Separator usage rates (among names where a separator could appear). */
  separators: { underscore: number; dot: number; dash: number; space: number };
  /** Casing rates. */
  casing: { allLower: number; allUpper: number; titleCase: number };
  /**
   * P(Georgian-script name). Small-n rare feature: presence-only, widened.
   */
  georgianScriptRate: number;
  /** Observed trailing-digit token frequencies (e.g. "14", "09", "23"). */
  trailingDigitTokens: WeightedString[];
}

export interface AvatarPatterns {
  source: DistributionSource;
  /** P(a bot has any avatarCustomization at all) — real coverage is sparse. */
  presenceRate: number;
  hair: WeightedString[];
  jersey: WeightedString[];
  skin: WeightedString[];
  /** P(facialHair present | customization present) + value weights. */
  facialHairRate: number;
  facialHair: WeightedString[];
  glassesRate: number;
  glasses: WeightedString[];
  /** Raw measured hair distribution, retained for report disclosure. */
  rawHairMeasured?: WeightedString[];
}

export interface CountryCity {
  code: string;
  cities: { name: string; lat: number; lng: number }[];
}

export interface CountryPatterns {
  source: DistributionSource;
  /** Imposed target distribution used by the generator. */
  distribution: WeightedString[];
  /** Raw measured distribution, retained for report disclosure. */
  rawMeasured: WeightedString[];
  /** One-line rationale printed in the report when source === 'overridden'. */
  rationale?: string;
  /** Curated cities + coords per country code. */
  cities: CountryCity[];
}

export interface ClubPatterns {
  source: DistributionSource;
  /** P(favorite_club non-null) — real coverage is very sparse. */
  nonNullRate: number;
  distribution: WeightedString[];
}

export interface ActivityPatterns {
  source: DistributionSource;
  /**
   * Raw hourly match-start histogram, Asia/Tbilisi (24 buckets). Retained for
   * report disclosure only; the archetypes below are learned per-user, NOT from
   * this aggregate (§1.3: an aggregate histogram cannot yield per-user patterns).
   */
  hourlyHistogram: number[];
  /**
   * Schedule archetypes CLUSTERED from per-user activity: each real player's
   * match-start sequence is segmented into sessions on 20-minute gaps, then a
   * per-user (peak-hour, sessions/day, session-length, matches/day) tuple is
   * assigned to the nearest archetype. Weights are the share of users in each
   * cluster. Daily cap is carried on the archetype so (schedule, cap) are
   * JOINTLY sampled — a night-owl can never draw a 15-match cap.
   */
  scheduleArchetypes: ScheduleArchetype[];
  /** Number of real users the per-user clustering was computed over. */
  usersClustered: number;
}

export interface ScheduleArchetype {
  key: string;
  weight: number;
  /** Active-hour window (Asia/Tbilisi), inclusive start, exclusive end (may wrap). */
  startHour: number;
  endHour: number;
  /** Typical session length in matches [min,max]. */
  sessionLength: [number, number];
  /**
   * Daily-cap distribution for THIS archetype, as empirical quantiles
   * [cumulativeProb, cap]. Sampled jointly with the archetype so caps stay
   * consistent with the window (night-owls get small caps).
   */
  dailyCapQuantiles: [number, number][];
}

export interface RenamePatterns {
  source: DistributionSource;
  /** Lifetime P(bot renames at least once). */
  lifetimeRate: number;
  /** Raw measured rate (staging under-sample), for disclosure. */
  rawMeasuredRate: number;
}

export interface SkillBandPatterns {
  /** 20/30/30/15/5 band split (bottom→top). */
  bandWeights: number[];
  /** Hidden base_skill range per band on the calibration scale. */
  bandRanges: [number, number][];
}

export interface RosterPatterns {
  schemaVersion: 1;
  generatedAt: string;
  measuredAgainst: string;
  cohort: {
    realWithIdentity: number;
    namedUsers: number;
    namedAndPlayed: number;
    everPlayed: number;
  };
  /**
   * FROZEN case-insensitive nickname exclusion set (all users.nickname ∪
   * nickname_history old+new), captured at measurement time. The generator and
   * the creation script use THIS snapshot so a name free at approval cannot
   * become taken by a live signup before creation, which would silently diverge
   * the reproducible sequence. Creation additionally does a live final-collision
   * check as a separate post-pass.
   *
   * PRIVACY: the set holds ~23.5k real user nicknames (often full personal
   * names). We only need MEMBERSHIP testing, so the committed artifact stores
   * salted HASHES, never plaintext. Each entry is
   * sha256(salt + nfcNormalizedLower(name)); the random salt is committed
   * alongside (it only prevents casual bulk reading — targeted membership
   * testing IS the intended feature). Plaintext is never written to any file.
   */
  exclusion: {
    count: number;
    /** Hash algorithm + construction, for forward-compat. */
    algorithm: 'sha256(salt+nfcLower)';
    /** Random hex salt generated at measure time and committed. */
    salt: string;
    /** sha256 digest of the sorted hash list (stable content id). */
    sha256: string;
    /** The salted hashes themselves (sorted hex). Membership-test only. */
    hashes: string[];
    /**
     * Provenance of the set: how many distinct names came from this DB vs from
     * each `--exclude-names` file (e.g. another environment's roster CSV, whose
     * names must stay reserved even though this DB has never seen them).
     * Labels are basenames only — no absolute paths in the committed artifact.
     */
    sources?: {
      db: number;
      extra: { label: string; count: number }[];
    };
  };
  /**
   * FROZEN list of real, active category slugs measured from the DB (hyphenated,
   * e.g. 'world-cup', 'premier-league'). Category affinities are sampled from
   * THESE so stored affinity keys are live slugs, not invented underscore names.
   * Daily-challenge format sub-categories are excluded (they are quiz formats,
   * not skill domains).
   */
  categorySlugs: string[];
  name: NameStructurePatterns;
  avatar: AvatarPatterns;
  country: CountryPatterns;
  club: ClubPatterns;
  activity: ActivityPatterns;
  rename: RenamePatterns;
  skill: SkillBandPatterns;
}
