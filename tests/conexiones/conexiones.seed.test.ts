import { describe, expect, it } from 'vitest';
import { foldName } from '../../src/modules/conexiones/conexiones.seed.js';

// Invented names.
describe('foldName', () => {
  it('one person spelled with or without letters NFKD keeps whole matches', () => {
    expect(foldName('Ødegård Invented')).toBe(foldName('Odegard Invented'));
    expect(foldName('Łukasz Inventski')).toBe('lukasz inventski');
    expect(foldName('Weißmann')).toBe('weissmann');
    expect(foldName('Ærøskøbing Fictio')).toBe('aeroskobing fictio');
    expect(foldName('Yıldız Örnek')).toBe('yildiz ornek');
    expect(foldName('José  Pérez-Inventado')).toBe('jose perez inventado');
  });
});
