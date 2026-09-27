import { MIN_TOKEN_SECRET_LENGTH } from './buscaminas.constants.js';
import type { ContentLoader } from './buscaminas.content.js';

export function tokenSecretProblem(secret: string | undefined): string | null {
  if (!secret) return 'BUSCAMINAS_TOKEN_SECRET is not set';
  if (secret.length < MIN_TOKEN_SECRET_LENGTH) return `BUSCAMINAS_TOKEN_SECRET must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`;
  return null;
}

/** The secret when it is usable, else undefined (the module then answers 503). */
export const usableTokenSecret = (secret: string | undefined): string | undefined =>
  tokenSecretProblem(secret) ? undefined : secret;

export interface ReadinessDeps {
  enabled: boolean;
  tokenSecret: string | undefined;
  content: Pick<ContentLoader, 'check'>;
  log: {
    error: (obj: Record<string, unknown>, msg: string) => void;
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Boot-time readiness: decrypts and validates the answers eagerly so a missing or
 * wrong secret/key, or a short calendar, is ONE clear error at deploy time instead of
 * a silent 503 on first traffic. Never throws; problems name variables, never values.
 */
export async function checkBuscaminasReadiness(deps: ReadinessDeps): Promise<{ ready: boolean; problems: string[] }> {
  if (!deps.enabled) return { ready: false, problems: [] };
  const problems: string[] = [];
  try {
    const secret = tokenSecretProblem(deps.tokenSecret);
    if (secret) problems.push(secret);
    const content = await deps.content.check();
    if (!content.ok) problems.push(`content: ${content.reason}`);
    if (problems.length === 0) {
      deps.log.info({ days: content.ok ? content.days : 0 }, 'Buscaminas ready');
      return { ready: true, problems };
    }
  } catch (error) {
    problems.push(`readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  deps.log.error({ problems }, `Buscaminas is enabled but every endpoint answers 503: ${problems.join('; ')}`);
  return { ready: false, problems };
}
