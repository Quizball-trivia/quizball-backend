import { config } from '../../core/config.js';
import { ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type {
  AdminCampaignQuizGooglebotResponse,
  AdminCampaignQuizPageResponse,
} from './campaign-quizzes.schemas.js';

const GOOGLEBOT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const MAX_PREVIEW_HTML_BYTES = 2 * 1024 * 1024;

async function readPreviewHtml(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new ExternalServiceError('The server-rendered preview did not return HTML');
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_HTML_BYTES) {
    throw new ExternalServiceError('The server-rendered preview is too large to inspect');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREVIEW_HTML_BYTES) {
      await reader.cancel();
      throw new ExternalServiceError('The server-rendered preview is too large to inspect');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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

    const html = await readPreviewHtml(response);
    const canonical = `${config.PUBLIC_SITE_ORIGIN.replace(/\/+$/, '')}/en/football-quiz/${page.slug}`;
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
