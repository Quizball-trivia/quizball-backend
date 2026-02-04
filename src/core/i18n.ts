/**
 * Extracts localized text from an i18n field object.
 * Prefers English ('en') if available, otherwise returns the first available value.
 */
export function pickI18nText(field: Record<string, string> | null | undefined): string {
  if (!field) return '';
  if (typeof field.en === 'string') return field.en;
  const first = Object.values(field)[0];
  return typeof first === 'string' ? first : '';
}
