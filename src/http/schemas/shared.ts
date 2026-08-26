import { z } from 'zod';
import { isSupportedIsoCountryCode } from '../../core/country.js';

export const MAX_LEADERBOARD_OFFSET = 10_000;

/**
 * OFFSET pagination is retained for the current leaderboard UI, but bounded so
 * callers cannot force deep scans, numeric overflows, or unbounded cache keys.
 */
export const leaderboardOffsetSchema = z.coerce
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(MAX_LEADERBOARD_OFFSET)
  .optional()
  .default(0);

/**
 * Canonical persisted country code. Lowercase/whitespace variants normalize at
 * the API boundary; names, private labels, legacy aliases and unknown codes do
 * not enter `users.country`.
 */
export const countryCodeSchema = z
  .string()
  .trim()
  .length(2, { message: 'Country must be an ISO 3166-1 alpha-2 code' })
  .transform((value) => value.toUpperCase())
  .refine(isSupportedIsoCountryCode, {
    message: 'Country must be a supported ISO 3166-1 alpha-2 code',
  });

/**
 * i18n field schema - object with ISO 639-1 language codes as keys.
 * Used for multilingual content (e.g., { en: 'Hello', ka: 'გამარჯობა' }).
 *
 * Validation rules:
 * - Keys: 2-character lowercase language codes (ISO 639-1 format)
 * - Values: Non-empty strings
 * - At least one translation required
 *
 * Examples:
 * - Valid: { en: "Hello" }, { en: "Hello", ka: "გამარჯობა" }
 * - Invalid: {}, { en: "" }, { english: "Hello" }, { EN: "Hello" }
 */
export const i18nFieldSchema = z
  .record(
    z.string().length(2).regex(/^[a-z]{2}$/, {
      message: 'Language code must be 2 lowercase letters (ISO 639-1)',
    }),
    z.string().min(1, { message: 'Translation cannot be empty' })
  )
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one translation is required',
  });

export type I18nField = z.infer<typeof i18nFieldSchema>;

/**
 * Shared pagination query schema.
 * Use with .merge() in module-specific schemas.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Factory for paginated response schemas.
 */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: z.array(dataSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  });

/**
 * Generic paginated response type.
 */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}
