/**
 * Unit tests for the public-serialization masking predicate (PR3).
 *
 * `isPubliclyHumanPresenting` drives the outward `isAi` field: real humans and
 * persistent roster bots present as human (isAi:false); ephemeral/auction bots
 * and any unknown ai_kind present as AI (isAi:true). The DB's is_ai/ai_kind are
 * never rewritten — only the serialized view is masked.
 */
import { describe, expect, it } from 'vitest';

import { isPubliclyHumanPresenting } from '../../src/modules/users/ai-classification.js';

describe('isPubliclyHumanPresenting', () => {
  it('presents humans and persistent bots as human; ephemeral/auction/unknown as AI', () => {
    expect(isPubliclyHumanPresenting({ is_ai: false, ai_kind: null })).toBe(true);
    expect(isPubliclyHumanPresenting({ is_ai: true, ai_kind: 'persistent' })).toBe(true);

    expect(isPubliclyHumanPresenting({ is_ai: true, ai_kind: 'ephemeral' })).toBe(false);
    expect(isPubliclyHumanPresenting({ is_ai: true, ai_kind: 'auction' })).toBe(false);
    expect(isPubliclyHumanPresenting({ is_ai: true, ai_kind: null })).toBe(false);
    expect(isPubliclyHumanPresenting({ is_ai: true, ai_kind: 'something-new' })).toBe(false);
  });

  it('the public isAi field (its negation) masks persistent bots only', () => {
    const publicIsAi = (u: { is_ai: boolean; ai_kind: string | null }) => !isPubliclyHumanPresenting(u);

    expect(publicIsAi({ is_ai: false, ai_kind: null })).toBe(false);
    expect(publicIsAi({ is_ai: true, ai_kind: 'persistent' })).toBe(false);
    expect(publicIsAi({ is_ai: true, ai_kind: 'ephemeral' })).toBe(true);
    expect(publicIsAi({ is_ai: true, ai_kind: 'auction' })).toBe(true);
  });
});
