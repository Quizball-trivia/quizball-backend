import type { Json } from '../db/types.js';
import { config } from '../core/config.js';

export interface LocalizeOptions {
  preferredLocales?: string[];
  fallback?: string;
}

export function getLocalizedString(
  value: Json | null,
  options: LocalizeOptions = {}
): string {
  if (!value || typeof value !== 'object') {
    return options.fallback ?? 'Untitled';
  }

  const record = value as Record<string, string | undefined>;
  const preferredLocales = options.preferredLocales?.length
    ? options.preferredLocales
    : [config.DEFAULT_LOCALE];

  for (const locale of preferredLocales) {
    const normalized = locale.trim();
    const candidate = record[normalized];
    if (candidate && candidate.trim()) return candidate;
  }

  const fallbackValue = Object.values(record).find((val) => val && val.trim());
  return fallbackValue ?? (options.fallback ?? 'Untitled');
}

// Older/imported content often lists accepted answers in one script only, so a
// guess typed in the other locale (e.g. Georgian) can never match. Localized
// display values are always valid guesses; merging them in also lets whole-word
// matching accept a localized surname from a localized full name.
export function mergeLocalizedAcceptedAnswers(
  acceptedAnswers: readonly string[],
  ...localizedValues: Array<Json | null | undefined>
): string[] {
  const merged = [...acceptedAnswers];
  const seen = new Set(merged.map((answer) => answer.trim().toLowerCase()));

  for (const value of localizedValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const candidate of Object.values(value)) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
  }

  return merged;
}
