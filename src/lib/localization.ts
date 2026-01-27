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
