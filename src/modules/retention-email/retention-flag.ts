import { getPostHogFlagsConfig } from '../../core/analytics.js';
import { logger } from '../../core/logger.js';
import type { RetentionEmailVariant } from './retention-email.repo.js';
import { retentionFlagExclusionRepo } from './retention-flag-exclusions.repo.js';

// The flags endpoint is called directly rather than through posthog-node:
// the SDK's getFeatureFlag() hides `errorsWhileComputingFlags`, quota limits
// and the per-flag reason, and returns a plain `false` for all of them, so a
// transient failure would be indistinguishable from "this player is out".
const REQUEST_TIMEOUT_MS = 10_000;
// After an unknown answer, the flag is not asked about again for this long.
// Per flag, so a deleted or mistyped key cannot silence the other campaigns.
const REMOTE_BACKOFF_MS = 5 * 60_000;
// Only these reason codes say the player themselves does not match the flag.
// Anything else (flag paused, missing, evaluation error) is unknown and is
// never recorded as an exclusion.
const NOT_MATCHED_REASON_CODES = new Set(['no_condition_match', 'out_of_rollout_bound']);

const remoteUnavailableUntil = new Map<string, number>();

/** @internal test seam; production code must not clear the pause. */
export function resetRetentionFlagBackoffForTests(): void {
  remoteUnavailableUntil.clear();
}

type FlagsResponse = {
  flags?: Record<string, {
    enabled?: boolean;
    variant?: string | null;
    reason?: { code?: string | null } | null;
  } | undefined>;
  errorsWhileComputingFlags?: boolean;
  quotaLimited?: string[] | null;
};

type Evaluation =
  | { kind: 'variant'; variant: RetentionEmailVariant }
  | { kind: 'excluded'; reason: string }
  | { kind: 'unknown'; reason: string };

function classify(body: unknown, featureFlagKey: string): Evaluation {
  if (typeof body !== 'object' || body === null) return { kind: 'unknown', reason: 'malformed_body' };
  const response = body as FlagsResponse;
  if (response.quotaLimited?.includes('feature_flags')) return { kind: 'unknown', reason: 'quota_limited' };
  if (response.errorsWhileComputingFlags) return { kind: 'unknown', reason: 'errors_while_computing_flags' };
  const flag = response.flags?.[featureFlagKey];
  if (typeof flag !== 'object' || flag === null) return { kind: 'unknown', reason: 'flag_missing' };
  const code = flag.reason?.code ?? 'no_reason';
  if (flag.enabled === true) {
    if (flag.variant === 'control' || flag.variant === 'test') {
      return { kind: 'variant', variant: flag.variant };
    }
    if (typeof flag.variant === 'string' && flag.variant) {
      return { kind: 'excluded', reason: `variant_${flag.variant}` };
    }
    return { kind: 'unknown', reason: 'enabled_without_variant' };
  }
  if (flag.enabled === false && NOT_MATCHED_REASON_CODES.has(code)) {
    return { kind: 'excluded', reason: code };
  }
  return { kind: 'unknown', reason: flag.enabled === false ? code : 'malformed_flag' };
}

async function evaluate(
  config: { apiKey: string; host: string },
  input: { featureFlagKey: string; userId: string; country: string | null },
): Promise<Evaluation> {
  let body: unknown;
  try {
    const response = await fetch(`${config.host}/flags/?v=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.apiKey,
        distinct_id: input.userId,
        person_properties: { distinct_id: input.userId, country: input.country ?? '' },
        // Evaluate only this flag: a broken unrelated flag would otherwise set
        // errorsWhileComputingFlags for the whole response and pause this one.
        flag_keys_to_evaluate: [input.featureFlagKey],
        // Node's bare fetch user agent is classified as a client runtime, which
        // would hide flags restricted to server-side evaluation.
        evaluation_runtime: 'server',
        geoip_disable: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'unknown', reason: `http_${response.status}` };
    }
    body = await response.json();
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : 'request_failed' };
  }
  return classify(body, input.featureFlagKey);
}

/**
 * Resolves a candidate's experiment variant with one billed PostHog request.
 * A definite "this player does not match" is recorded so the candidate scans
 * skip the player for the exclusion TTL. An unknown answer records nothing
 * (it would silently drop the player for days) and pauses that flag.
 */
export async function resolveRetentionVariant(input: {
  featureFlagKey: string;
  userId: string;
  country: string | null;
  logContext: string;
}): Promise<RetentionEmailVariant | null> {
  const config = getPostHogFlagsConfig();
  if (!config) return null;
  if (Date.now() < (remoteUnavailableUntil.get(input.featureFlagKey) ?? 0)) return null;
  const outcome = await evaluate(config, input);
  if (outcome.kind === 'variant') return outcome.variant;
  if (outcome.kind === 'unknown') {
    remoteUnavailableUntil.set(input.featureFlagKey, Date.now() + REMOTE_BACKOFF_MS);
    logger.warn(
      { featureFlagKey: input.featureFlagKey, reason: outcome.reason, backoffMs: REMOTE_BACKOFF_MS },
      `${input.logContext} feature flag answer unknown; pausing this flag`,
    );
    return null;
  }
  try {
    await retentionFlagExclusionRepo.record({
      featureFlagKey: input.featureFlagKey,
      userId: input.userId,
    });
  } catch (error) {
    // Without the row the scans would hand this player back next tick and
    // bill another request for as long as the write keeps failing.
    remoteUnavailableUntil.set(input.featureFlagKey, Date.now() + REMOTE_BACKOFF_MS);
    logger.warn({ error }, `${input.logContext} feature flag exclusion was not recorded; pausing this flag`);
  }
  return null;
}
