import { logger } from './logger.js';

/**
 * Extracts localized text from an i18n field object.
 * Prefers English ('en') if available, otherwise returns the first available value.
 */
export function pickI18nText(field: Record<string, string> | string | null | undefined): string {
  // Handle null/undefined
  if (!field) return '';

  // Handle stringified JSON (JSONB not parsed by postgres.js)
  if (typeof field === 'string') {
    const trimmed = field.trim();
    // Try to parse as JSON if it looks like an object
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
          // Recursively call with parsed object
          return pickI18nText(parsed);
        }
      } catch (err) {
        logger.warn({ field, error: err }, 'Failed to parse JSON string in i18n field');
        return '';
      }
    }
    // If it's just a plain string, return it
    return field;
  }

  // Handle non-object types
  if (typeof field !== 'object' || Array.isArray(field)) {
    logger.warn({ field, fieldType: typeof field }, 'pickI18nText received non-object field');
    return '';
  }

  // Prefer English
  if (typeof field.en === 'string' && field.en.length > 0) {
    return field.en;
  }

  // Fall back to first available language
  const values = Object.values(field);
  if (values.length === 0) {
    logger.warn({ field }, 'pickI18nText received empty object');
    return '';
  }

  const first = values[0];
  if (typeof first === 'string' && first.length > 0) {
    return first;
  }

  logger.warn({ field, first }, 'pickI18nText could not extract valid text');
  return '';
}
