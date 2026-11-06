/** The languages a campaign quiz page can be served in. A new language is added here and in its migration. */
export const CAMPAIGN_QUIZ_LOCALES = ['en', 'ka', 'es', 'ru', 'pt', 'de', 'tr'] as const;
export type CampaignLocale = (typeof CAMPAIGN_QUIZ_LOCALES)[number];
export type EditionLocale = Exclude<CampaignLocale, 'en'>;
export const EDITION_LOCALES = CAMPAIGN_QUIZ_LOCALES.filter((locale): locale is EditionLocale => locale !== 'en');

export const EDITION_TEXT_FIELDS = [
  'title', 'h1', 'seo_title', 'meta_description', 'breadcrumb_label', 'lede', 'about_heading',
  'hero_image_alt', 'og_image_alt', 'score_cta', 'footer_banner_text', 'footer_button_label',
] as const;
export type EditionTextField = (typeof EDITION_TEXT_FIELDS)[number];

/** Editions that also need every served question in their language. es and ru predate the rule and fall back to English. */
export const QUESTION_GATED_LOCALES: ReadonlySet<CampaignLocale> = new Set<EditionLocale>(['ka', 'pt', 'de', 'tr']);

/** Editions that open only with every page field translated, so no English lede or footer shows on them. */
export const FULL_COPY_LOCALES: readonly EditionLocale[] = ['ka', 'tr'];

export const editionColumns = (fields: readonly string[]): string[] =>
  EDITION_LOCALES.flatMap((locale) => fields.map((field) => `${locale}_${field}`));

type EditionColumn<Field extends string> = `${EditionLocale}_${Field}`;
type EditionCopy<Value, Field extends string> = Partial<Record<EditionColumn<Field>, Value | null>>;

/** The page column of a translated edition; null means "use the English column". */
export function editionText<Value, Field extends string>(row: EditionCopy<Value, Field>, locale: CampaignLocale, field: Field): Value | null {
  if (locale === 'en') return null;
  return row[`${locale}_${field}`] ?? null;
}

type AboutBlockText = { text: string };
type EditionPageFields = { locale_mode: 'en_only' | 'en_ka' }
  & Partial<Record<EditionTextField, string | null>>
  & { about_blocks?: AboutBlockText[] | null }
  & EditionCopy<string, EditionTextField>
  & EditionCopy<AboutBlockText[], 'about_blocks'>;

/** The page fields with English that the language has no text for; about_blocks needs every block, as an array. */
export function missingEditionCopy(page: EditionPageFields, locale: EditionLocale): string[] {
  const filled = (value: string | null | undefined) => Boolean(value?.trim());
  const missing: string[] = EDITION_TEXT_FIELDS.filter((field) => filled(page[field]) && !filled(page[`${locale}_${field}`]));
  const english = page.about_blocks ?? [];
  const translated = page[`${locale}_about_blocks`];
  const blocksComplete = Array.isArray(translated) && translated.length === english.length && translated.every((block) => filled(block?.text));
  if (english.length > 0 && !blocksComplete) missing.push('about_blocks');
  return missing;
}

/**
 * A language edition exists when its page copy does; the hub lists a page and its page offers a language by this rule.
 * Georgian is also switched on per page (locale_mode). FULL_COPY_LOCALES need every page field, the older editions the
 * three SEO fields. QUESTION_GATED_LOCALES also need their questions, which the callers check with the set in hand.
 */
export function hasEdition(page: EditionPageFields, locale: CampaignLocale): boolean {
  if (locale === 'en') return true;
  if (locale === 'ka' && page.locale_mode !== 'en_ka') return false;
  if (!page[`${locale}_h1`] || !page[`${locale}_seo_title`] || !page[`${locale}_meta_description`]) return false;
  return !FULL_COPY_LOCALES.includes(locale) || missingEditionCopy(page, locale).length === 0;
}
