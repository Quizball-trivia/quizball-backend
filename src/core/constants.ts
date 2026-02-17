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

function parseHostFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    // If env accidentally contains host-only entries, keep them.
    return origin.includes('.') || origin.includes(':') ? origin : null;
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
