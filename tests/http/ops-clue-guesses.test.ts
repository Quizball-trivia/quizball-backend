import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import type { Request, Response } from 'express';
import { AuthenticationError, InternalError } from '../../src/core/errors.js';
import { clueGuessQuerySchema } from '../../src/modules/ops/ops.schemas.js';

const listRecentMock = vi.hoisted(() => vi.fn());
const configMock = vi.hoisted(() => ({ OPS_REPORT_TOKEN: 'secret-ops-token' as string | undefined }));

vi.mock('../../src/core/config.js', () => ({ config: configMock }));

vi.mock('../../src/modules/matches/clue-guess-evaluations.repo.js', () => ({
  clueGuessEvaluationsRepo: {
    listRecent: (...args: unknown[]) => listRecentMock(...args),
  },
}));

vi.mock('../../src/modules/ops/ops.service.js', () => ({
  opsService: { sendDailyReportEmail: vi.fn() },
}));

const { opsController } = await import('../../src/modules/ops/ops.controller.js');

const QUESTION_ID = '33333333-3333-4333-8333-333333333333';

function makeReq(headers: Record<string, string>, query: unknown): Request {
  return { headers, validated: { query } } as unknown as Request;
}

function makeRes(): Response & { body?: unknown } {
  const res = {
    body: undefined as unknown,
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { body?: unknown };
}

beforeEach(() => {
  listRecentMock.mockReset();
  listRecentMock.mockResolvedValue([]);
  configMock.OPS_REPORT_TOKEN = 'secret-ops-token';
});

describe('GET /internal/ops/clue-guesses auth', () => {
  const query = { questionId: QUESTION_ID, limit: 50 };

  it('rejects a request with no ops token', async () => {
    await expect(opsController.listClueGuesses(makeReq({}, query), makeRes()))
      .rejects.toBeInstanceOf(AuthenticationError);
    expect(listRecentMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong ops token', async () => {
    const req = makeReq({ 'x-ops-report-token': 'wrong-token' }, query);
    await expect(opsController.listClueGuesses(req, makeRes()))
      .rejects.toBeInstanceOf(AuthenticationError);
    expect(listRecentMock).not.toHaveBeenCalled();
  });

  it('rejects a token that is a prefix of the real one (no length leak)', async () => {
    const req = makeReq({ 'x-ops-report-token': 'secret' }, query);
    await expect(opsController.listClueGuesses(req, makeRes()))
      .rejects.toBeInstanceOf(AuthenticationError);
  });

  it('fails closed when OPS_REPORT_TOKEN is unset', async () => {
    configMock.OPS_REPORT_TOKEN = undefined;
    const req = makeReq({ 'x-ops-report-token': 'anything' }, query);
    await expect(opsController.listClueGuesses(req, makeRes()))
      .rejects.toBeInstanceOf(InternalError);
    expect(listRecentMock).not.toHaveBeenCalled();
  });

  it('serves rows for a valid ops token', async () => {
    listRecentMock.mockResolvedValue([{ id: '1', raw_guess: 'Roman Burki' }]);
    const res = makeRes();
    await opsController.listClueGuesses(makeReq({ 'x-ops-report-token': 'secret-ops-token' }, query), res);

    expect(listRecentMock).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ ok: true, count: 1 });
  });
});

describe('clue-guesses query handling', () => {
  const authed = { 'x-ops-report-token': 'secret-ops-token' };

  it('defaults to rejects-only and excludes AI traffic', async () => {
    await opsController.listClueGuesses(makeReq(authed, { questionId: QUESTION_ID, limit: 50 }), makeRes());
    expect(listRecentMock.mock.calls[0][0]).toMatchObject({
      questionId: QUESTION_ID,
      rejectsOnly: true,
      excludeAi: true,
      limit: 50,
    });
  });

  it('honours explicit opt-in to accepts and AI rows', async () => {
    const query = { userId: QUESTION_ID, rejectsOnly: 'false', includeAi: 'true', limit: 10 };
    await opsController.listClueGuesses(makeReq(authed, query), makeRes());
    expect(listRecentMock.mock.calls[0][0]).toMatchObject({ rejectsOnly: false, excludeAi: false });
  });
});

describe('clueGuessQuerySchema', () => {
  it('requires at least one selector so the endpoint cannot bulk-dump guesses', () => {
    expect(clueGuessQuerySchema.safeParse({}).success).toBe(false);
    expect(clueGuessQuerySchema.safeParse({ limit: 50 }).success).toBe(false);
  });

  it('accepts any single selector', () => {
    expect(clueGuessQuerySchema.safeParse({ questionId: QUESTION_ID }).success).toBe(true);
    expect(clueGuessQuerySchema.safeParse({ userId: QUESTION_ID }).success).toBe(true);
    expect(clueGuessQuerySchema.safeParse({ matchId: QUESTION_ID }).success).toBe(true);
  });

  it('defaults limit to 50 and caps it at 200', () => {
    const parsed = clueGuessQuerySchema.safeParse({ questionId: QUESTION_ID });
    expect(parsed.success && parsed.data.limit).toBe(50);
    expect(clueGuessQuerySchema.safeParse({ questionId: QUESTION_ID, limit: 201 }).success).toBe(false);
    expect(clueGuessQuerySchema.safeParse({ questionId: QUESTION_ID, limit: 0 }).success).toBe(false);
  });

  it('rejects a non-uuid selector', () => {
    expect(clueGuessQuerySchema.safeParse({ questionId: 'not-a-uuid' }).success).toBe(false);
  });
});
