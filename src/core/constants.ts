/**
 * Application constants.
 */
import { config } from './config.js';

/**
 * Allowed redirect domains for OAuth and password reset flows.
 * Prevents open redirect vulnerabilities.
 */
const DEV_DOMAINS = [
  'localhost:3000',
  'localhost:3001',
  'localhost:5173',
  'localhost:8000',
  '127.0.0.1:3000',
  '127.0.0.1:3001',
  '127.0.0.1:5173',
  '127.0.0.1:8000',
];
const PROD_DOMAINS = ['quizball.io', 'www.quizball.io', 'quizball.app', 'www.quizball.app'];
const isProd = config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging';

// Matches valid hostname/IPv4 with optional port, or bracketed IPv6.
const VALID_HOST_RE = /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/;

function parseHostFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    // If env accidentally contains host-only entries (no scheme), accept if valid hostname.
    return VALID_HOST_RE.test(origin) ? origin : null;
  }
}

const corsOriginHosts = (config.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map(parseHostFromOrigin)
  .filter((host): host is string => Boolean(host));

const DEV_AND_CORS_DOMAINS = Array.from(new Set([...DEV_DOMAINS, ...corsOriginHosts]));

export const ALLOWED_REDIRECT_DOMAINS = isProd
  ? PROD_DOMAINS
  : [...DEV_AND_CORS_DOMAINS, ...PROD_DOMAINS];
