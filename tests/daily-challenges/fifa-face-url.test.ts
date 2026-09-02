import { describe, expect, it } from 'vitest';
import { fifaFaceSignature, verifyFifaFaceSignature } from '../../src/modules/daily-challenges/fifa-face-url.js';

describe('fifa face url signing', () => {
  it('signs deterministically and verifies in constant time', () => {
    const sig = fifaFaceSignature(158023, '24', 'test-secret-0123456789');
    expect(sig).toHaveLength(32);
    expect(fifaFaceSignature(158023, '24', 'test-secret-0123456789')).toBe(sig);
    expect(verifyFifaFaceSignature(158023, '24', sig, 'test-secret-0123456789')).toBe(true);
    expect(verifyFifaFaceSignature(158023, '25', sig, 'test-secret-0123456789')).toBe(false);
    expect(verifyFifaFaceSignature(158024, '24', sig, 'test-secret-0123456789')).toBe(false);
    expect(verifyFifaFaceSignature(158023, '24', sig, 'another-secret-0123456789')).toBe(false);
    expect(verifyFifaFaceSignature(158023, '24', sig.slice(0, 10), 'test-secret-0123456789')).toBe(false);
  });
});
