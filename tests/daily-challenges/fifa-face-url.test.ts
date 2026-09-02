import { describe, expect, it } from 'vitest';
import '../setup.js';
import { buildFifaFaceUrl } from '../../src/modules/daily-challenges/fifa-face-url.js';

describe('fifa face url', () => {
  it('points at the mirrored face in our storage bucket', () => {
    const url = buildFifaFaceUrl(158023, '24');
    expect(url).toMatch(/^https?:\/\/.+\/storage\/v1\/object\/public\/imgs\/fifa-faces\/158023_24\.webp$/);
  });
  it('is null without a photo', () => {
    expect(buildFifaFaceUrl(null, '24')).toBeNull();
    expect(buildFifaFaceUrl(158023, null)).toBeNull();
  });
});
