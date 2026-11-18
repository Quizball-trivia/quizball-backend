import { describe, expect, it } from 'vitest';
import { toPlayerView } from '../../src/modules/squad-spin/squad-spin.service.js';

// Invented player. The answer and reveal payloads carry every localized name the resolver judges with.
const row = { id: 'p-1', name_en: 'Tomas Varnik', name_ka: null, name_ru: 'Томас Варник', name_el: 'Τόμας Βάρνικ', image_url: null, position_group: 'DEF' as const, nationality_code: null };

describe('Squad Spin player view', () => {
  it('keeps the Greek name, and null when there is none', () => {
    expect(toPlayerView(row)).toMatchObject({ name_el: 'Τόμας Βάρνικ', name_ru: 'Томас Варник' });
    expect(toPlayerView({ ...row, name_el: null }).name_el).toBeNull();
  });
});
