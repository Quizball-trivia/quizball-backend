import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_ISO_COUNTRY_CODES,
  isSupportedIsoCountryCode,
  normalizeCountryCode,
  normalizeSupportedCountryCode,
} from '../../src/core/country.js';

describe('persisted country codes', () => {
  it('ships the complete ISO 3166-1 alpha-2 set without duplicates', () => {
    expect(SUPPORTED_ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(SUPPORTED_ISO_COUNTRY_CODES)).toHaveLength(249);
  });

  it('normalizes case and whitespace only for supported codes', () => {
    expect(normalizeSupportedCountryCode(' ge ')).toBe('GE');
    expect(normalizeSupportedCountryCode('us')).toBe('US');
    expect(normalizeSupportedCountryCode('ZZ')).toBeNull();
    expect(normalizeSupportedCountryCode('Georgia')).toBeNull();
  });

  it('keeps friendly-name handling display-only and rejects unknown two-letter values', () => {
    expect(normalizeCountryCode('Georgia')).toBe('GE');
    expect(normalizeCountryCode('GEO')).toBe('GE');
    expect(normalizeCountryCode('ZZ')).toBeNull();
    expect(isSupportedIsoCountryCode('GE')).toBe(true);
    expect(isSupportedIsoCountryCode('ZZ')).toBe(false);
  });
});
