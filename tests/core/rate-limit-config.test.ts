import { describe, expect, it } from 'vitest';
import { config } from '../../src/core/config.js';

describe('RATE_LIMIT_AUTH_MAX', () => {
  it('is a positive auth-request ceiling sized for a carrier-NAT crowd', () => {
    expect(config.RATE_LIMIT_AUTH_MAX).toBeGreaterThanOrEqual(400);
  });
});
