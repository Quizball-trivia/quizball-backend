/**
 * Per-bot admin edit — schema/validation layer (layer 1 of 2).
 *
 * Layer 2 is the CHECK constraints in 20260729140000_bot_admin_edits.sql plus
 * the server-side RP ceiling rail, both exercised in the integration suite.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import {
  patchBotBodySchema,
  MIN_BASE_SKILL,
  MAX_BASE_SKILL,
  MAX_DAILY_CAP,
  BOT_NICKNAME_MAX_LENGTH,
} from '../../src/modules/bots/tuning/tuning.schemas.js';

const withNote = (body: Record<string, unknown>) => ({ note: 'tuning down', ...body });

describe('patch body: the mandatory note', () => {
  it('REJECTS a body with no note (audit row would be meaningless)', () => {
    expect(patchBotBodySchema.safeParse({ dailyCap: 5 }).success).toBe(false);
  });

  it('REJECTS a whitespace-only note', () => {
    expect(patchBotBodySchema.safeParse({ dailyCap: 5, note: '   ' }).success).toBe(false);
  });

  it('ACCEPTS a real note', () => {
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: 5 })).success).toBe(true);
  });
});

describe('patch body: at least one editable field', () => {
  it('REJECTS a note-only body (nothing to change)', () => {
    expect(patchBotBodySchema.safeParse({ note: 'just because' }).success).toBe(false);
  });

  it('REJECTS unknown fields (strict) — e.g. trying to edit governor state', () => {
    const result = patchBotBodySchema.safeParse(withNote({ governorAdjustment: -0.5 }));
    expect(result.success).toBe(false);
  });
});

describe('patch body: base skill stays inside the roster band range', () => {
  it('REJECTS below the band floor', () => {
    expect(patchBotBodySchema.safeParse(withNote({ baseSkill: MIN_BASE_SKILL - 0.01 })).success).toBe(false);
  });

  it('REJECTS above the band ceiling (the "make bots smarter" direction)', () => {
    expect(patchBotBodySchema.safeParse(withNote({ baseSkill: MAX_BASE_SKILL + 0.01 })).success).toBe(false);
  });

  it('REJECTS a wildly out-of-scale value', () => {
    expect(patchBotBodySchema.safeParse(withNote({ baseSkill: 4.0 })).success).toBe(false);
  });

  it('ACCEPTS both band boundaries exactly', () => {
    expect(patchBotBodySchema.safeParse(withNote({ baseSkill: MIN_BASE_SKILL })).success).toBe(true);
    expect(patchBotBodySchema.safeParse(withNote({ baseSkill: MAX_BASE_SKILL })).success).toBe(true);
  });
});

describe('patch body: daily cap', () => {
  it(`REJECTS above the hard rail of ${MAX_DAILY_CAP}`, () => {
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: MAX_DAILY_CAP + 1 })).success).toBe(false);
  });

  it('REJECTS a negative cap', () => {
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: -1 })).success).toBe(false);
  });

  it('REJECTS a fractional cap (smallint column)', () => {
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: 5.5 })).success).toBe(false);
  });

  it('ACCEPTS 0 (bot parked without retiring it) and the max', () => {
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: 0 })).success).toBe(true);
    expect(patchBotBodySchema.safeParse(withNote({ dailyCap: MAX_DAILY_CAP })).success).toBe(true);
  });
});

describe('patch body: RP set vs adjust are mutually exclusive', () => {
  it('REJECTS supplying both (ambiguous intent)', () => {
    expect(patchBotBodySchema.safeParse(withNote({ rpSet: 1000, rpAdjust: -50 })).success).toBe(false);
  });

  it('REJECTS a negative absolute RP', () => {
    expect(patchBotBodySchema.safeParse(withNote({ rpSet: -1 })).success).toBe(false);
  });

  it('ACCEPTS a NEGATIVE adjust (the weaker direction)', () => {
    expect(patchBotBodySchema.safeParse(withNote({ rpAdjust: -200 })).success).toBe(true);
  });

  it('ACCEPTS a positive adjust at the schema layer (the ceiling rail is server-side)', () => {
    // Deliberate: the schema cannot know the live human #10, so a large value
    // parses here and is rejected by the controller's rail. Asserted so a future
    // refactor does not "helpfully" cap it here and skip the real check.
    expect(patchBotBodySchema.safeParse(withNote({ rpAdjust: 99999 })).success).toBe(true);
  });
});

describe('patch body: nickname mirrors the human rename rules', () => {
  it('REJECTS an empty nickname', () => {
    expect(patchBotBodySchema.safeParse(withNote({ nickname: '' })).success).toBe(false);
  });

  it('REJECTS whitespace-only (trimmed to empty)', () => {
    expect(patchBotBodySchema.safeParse(withNote({ nickname: '   ' })).success).toBe(false);
  });

  it(`REJECTS longer than ${BOT_NICKNAME_MAX_LENGTH} (same bound as PUT /users/me)`, () => {
    const tooLong = 'a'.repeat(BOT_NICKNAME_MAX_LENGTH + 1);
    expect(patchBotBodySchema.safeParse(withNote({ nickname: tooLong })).success).toBe(false);
  });

  it('ACCEPTS unicode and spaces — humans may register these, so bots must too', () => {
    // No charset regex on purpose: a stricter rule here would make roster bots
    // unable to hold names real players can, which is a de-anonymising tell.
    expect(patchBotBodySchema.safeParse(withNote({ nickname: 'გიორგი 10' })).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = patchBotBodySchema.safeParse(withNote({ nickname: '  Kakha  ' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.nickname).toBe('Kakha');
  });
});
