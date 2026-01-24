/**
 * Application constants.
 */

/**
 * Allowed redirect domains for OAuth and password reset flows.
 * Prevents open redirect vulnerabilities.
 */
export const ALLOWED_REDIRECT_DOMAINS = [
  'localhost:3000',
  'localhost:8000',
  'quizball.app',
  'www.quizball.app',
];
