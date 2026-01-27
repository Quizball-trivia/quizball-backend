import { describe, it, expect } from 'vitest';
import { i18nFieldSchema } from '../../src/http/schemas/shared.js';

describe('i18nFieldSchema validation', () => {
  describe('Valid inputs', () => {
    it('should accept single translation', () => {
      const result = i18nFieldSchema.safeParse({ en: 'Hello' });
      expect(result.success).toBe(true);
    });

    it('should accept multiple translations', () => {
      const result = i18nFieldSchema.safeParse({
        en: 'Hello',
        ka: 'გამარჯობა',
        es: 'Hola',
      });
      expect(result.success).toBe(true);
    });

    it('should accept all valid 2-char lowercase codes', () => {
      const result = i18nFieldSchema.safeParse({
        en: 'English',
        fr: 'French',
        de: 'German',
        ja: 'Japanese',
        zh: 'Chinese',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Invalid inputs - empty object', () => {
    it('should reject empty object', () => {
      const result = i18nFieldSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('At least one translation');
      }
    });
  });

  describe('Invalid inputs - empty strings', () => {
    it('should reject empty translation value', () => {
      const result = i18nFieldSchema.safeParse({ en: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Translation cannot be empty');
      }
    });

    it('should reject if any translation is empty', () => {
      const result = i18nFieldSchema.safeParse({ en: 'Valid', ka: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('Invalid inputs - invalid language codes', () => {
    it('should reject language code with wrong length', () => {
      const result = i18nFieldSchema.safeParse({ english: 'Hello' });
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod validates length first, then regex
        expect(result.error.errors[0].message).toContain('exactly 2 character');
      }
    });

    it('should reject uppercase language code', () => {
      const result = i18nFieldSchema.safeParse({ EN: 'Hello' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('must be 2 lowercase letters');
      }
    });

    it('should reject language code with numbers', () => {
      const result = i18nFieldSchema.safeParse({ e1: 'Hello' });
      expect(result.success).toBe(false);
    });

    it('should reject language code with special characters', () => {
      const result = i18nFieldSchema.safeParse({ 'e-n': 'Hello' });
      expect(result.success).toBe(false);
    });

    it('should reject single character code', () => {
      const result = i18nFieldSchema.safeParse({ e: 'Hello' });
      expect(result.success).toBe(false);
    });

    it('should reject three character code', () => {
      const result = i18nFieldSchema.safeParse({ eng: 'Hello' });
      expect(result.success).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should accept valid code with Unicode value', () => {
      const result = i18nFieldSchema.safeParse({ ka: '🇬🇪 საქართველო' });
      expect(result.success).toBe(true);
    });

    it('should accept whitespace in values', () => {
      const result = i18nFieldSchema.safeParse({ en: '  Hello World  ' });
      expect(result.success).toBe(true);
    });

    it('should reject null values', () => {
      const result = i18nFieldSchema.safeParse({ en: null });
      expect(result.success).toBe(false);
    });

    it('should reject undefined values', () => {
      const result = i18nFieldSchema.safeParse({ en: undefined });
      expect(result.success).toBe(false);
    });

    it('should reject number values', () => {
      const result = i18nFieldSchema.safeParse({ en: 123 });
      expect(result.success).toBe(false);
    });
  });
});
