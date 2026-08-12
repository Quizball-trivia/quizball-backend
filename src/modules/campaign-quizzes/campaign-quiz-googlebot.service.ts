import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type {
  AdminCampaignQuizGooglebotResponse,
  AdminCampaignQuizPageResponse,
} from './campaign-quizzes.schemas.js';

const GOOGLEBOT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function includesPattern(html: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(html);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const campaignQuizGooglebotService = {
  async inspect(page: AdminCampaignQuizPageResponse): Promise<AdminCampaignQuizGooglebotResponse> {
    let response: Response;
    try {
      response = await fetch(page.preview_url, {
        headers: {
          'User-Agent': GOOGLEBOT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      logger.error({ error, url: page.preview_url }, 'Googlebot preview fetch failed');
      throw new ExternalServiceError('The server-rendered preview could not be fetched');
    }

    const html = await response.text();
    const canonical = `https://quizball.io/en/football-quiz/${page.slug}`;
    const canonicalPattern = new RegExp(
      `<link[^>]+(?:rel=["']canonical["'][^>]+href=["']${escapePattern(canonical)}["']|href=["']${escapePattern(canonical)}["'][^>]+rel=["']canonical["'])`,
      'i',
    );
    const hasEnglishAlternate = includesPattern(html, /hreflang=["']en["']/i);
    const hasGeorgianAlternate = includesPattern(html, /hreflang=["']ka["']/i);
    const questionMatches = html.match(/id=["']campaign-question-[^"']+["']/g) ?? [];
    const checks: AdminCampaignQuizGooglebotResponse['checks'] = [
      {
        key: 'http_response',
        label: 'HTTP response',
        passed: response.ok,
        detail: String(response.status),
      },
      {
        key: 'title',
        label: 'Title tag',
        passed: includesPattern(html, /<title>[^<]+<\/title>/i),
        detail: page.seo_title,
      },
      {
        key: 'meta_description',
        label: 'Meta description',
        passed: includesPattern(html, /<meta[^>]+name=["']description["'][^>]+content=["'][^"']+/i)
          || includesPattern(html, /<meta[^>]+content=["'][^"']+[^>]+name=["']description["']/i),
        detail: `${page.meta_description.length} characters`,
      },
      {
        key: 'canonical',
        label: 'Self-referencing canonical',
        passed: includesPattern(html, canonicalPattern),
        detail: canonical,
      },
      {
        key: 'hreflang',
        label: 'Language alternates',
        passed: hasEnglishAlternate && (page.locale_mode !== 'en_ka' || hasGeorgianAlternate),
        detail: page.locale_mode === 'en_ka' ? 'English and Georgian' : 'English only',
      },
      {
        key: 'webpage_schema',
        label: 'WebPage schema',
        passed: html.includes('"@type":"WebPage"'),
        detail: 'JSON-LD graph',
      },
      {
        key: 'breadcrumb_schema',
        label: 'Breadcrumb schema',
        passed: html.includes('"@type":"BreadcrumbList"'),
        detail: page.breadcrumb_label,
      },
      {
        key: 'game_schema',
        label: 'Game schema',
        passed: html.includes('"@type":"Game"'),
        detail: 'Free single-player quiz',
      },
      {
        key: 'question_html',
        label: 'Questions in initial HTML',
        passed: questionMatches.length >= page.question_count,
        detail: `${questionMatches.length} of ${page.question_count} question headings found`,
      },
    ];

    return {
      url: response.url || page.preview_url,
      fetched_at: new Date().toISOString(),
      status_code: response.status,
      html,
      checks,
    };
  },
};
