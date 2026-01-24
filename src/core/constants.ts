/**
 * Application constants.
 */
import { config } from './config.js';

/**
 * Allowed redirect domains for OAuth and password reset flows.
 * Prevents open redirect vulnerabilities.
 */
const DEV_DOMAINS = ['localhost:3000', 'localhost:8000'];
const PROD_DOMAINS = ['quizball.app', 'www.quizball.app'];
const isProd = config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging';

export const ALLOWED_REDIRECT_DOMAINS = isProd
  ? PROD_DOMAINS
  : [...DEV_DOMAINS, ...PROD_DOMAINS];
