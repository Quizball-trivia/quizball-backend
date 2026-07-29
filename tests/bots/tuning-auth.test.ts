/**
 * PR10 auth: every tuning endpoint is behind the ops shared secret and FAILS
 * CLOSED. These are write endpoints that change live bot difficulty, so an
 * unauthenticated caller must never reach the service layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup.js';
import type { Request } from 'express';
import { assertOpsAuthorized } from '../../src/modules/bots/tuning/tuning.controller.js';
import { AuthenticationError, InternalError } from '../../src/core/errors.js';
import { config } from '../../src/core/config.js';

function reqWith(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

describe('PR10 tuning auth guard', () => {
  const original = config.OPS_REPORT_TOKEN;

  beforeEach(() => {
    (config as { OPS_REPORT_TOKEN?: string }).OPS_REPORT_TOKEN = 'super-secret-ops-token';
  });

  afterEach(() => {
    (config as { OPS_REPORT_TOKEN?: string }).OPS_REPORT_TOKEN = original;
    vi.restoreAllMocks();
  });

  it('REJECTS a request with no token', () => {
    expect(() => assertOpsAuthorized(reqWith({}))).toThrow(AuthenticationError);
  });

  it('REJECTS a wrong token', () => {
    expect(() => assertOpsAuthorized(reqWith({ 'x-ops-report-token': 'nope' }))).toThrow(
      AuthenticationError,
    );
  });

  it('REJECTS a token that is a PREFIX of the real one', () => {
    expect(() =>
      assertOpsAuthorized(reqWith({ 'x-ops-report-token': 'super-secret' })),
    ).toThrow(AuthenticationError);
  });

  it('REJECTS an empty-string token', () => {
    expect(() => assertOpsAuthorized(reqWith({ 'x-ops-report-token': '' }))).toThrow(
      AuthenticationError,
    );
  });

  it('ACCEPTS the exact token', () => {
    expect(() =>
      assertOpsAuthorized(reqWith({ 'x-ops-report-token': 'super-secret-ops-token' })),
    ).not.toThrow();
  });

  it('accepts the first value when the header is repeated', () => {
    expect(() =>
      assertOpsAuthorized(reqWith({ 'x-ops-report-token': ['super-secret-ops-token', 'other'] })),
    ).not.toThrow();
  });

  it('FAILS CLOSED when OPS_REPORT_TOKEN is unset (never open to all)', () => {
    (config as { OPS_REPORT_TOKEN?: string }).OPS_REPORT_TOKEN = undefined;
    // InternalError, not a pass-through: an unconfigured deploy must not expose
    // difficulty controls to anonymous callers.
    expect(() =>
      assertOpsAuthorized(reqWith({ 'x-ops-report-token': 'anything' })),
    ).toThrow(InternalError);
  });
});
