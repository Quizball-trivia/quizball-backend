import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignQuizGooglebotService } from '../../src/modules/campaign-quizzes/campaign-quiz-googlebot.service.js';
import type { AdminCampaignQuizPageResponse } from '../../src/modules/campaign-quizzes/campaign-quizzes.schemas.js';

describe('campaignQuizGooglebotService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the preview as Googlebot and verifies SEO plus initial question HTML', async () => {
    const html = `<!doctype html><html><head>
      <title>Liverpool Quiz</title>
      <meta name="description" content="Free Liverpool quiz">
      <link rel="canonical" href="https://quizball.io/en/football-quiz/liverpool">
      <link rel="alternate" hreflang="en" href="https://quizball.io/en/football-quiz/liverpool">
      <script type="application/ld+json">{"@type":"WebPage"}</script>
      <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
      <script type="application/ld+json">{"@type":"Game"}</script>
      </head><body>
      <h3 id="campaign-question-one">Question one</h3>
      <h3 id="campaign-question-two">Question two</h3>
      </body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = {
      slug: 'liverpool',
      preview_url: 'http://localhost:3011/en/football-quiz/liverpool?preview=token',
      seo_title: 'Liverpool Quiz',
      meta_description: 'Free Liverpool quiz',
      breadcrumb_label: 'Liverpool Quiz',
      locale_mode: 'en_only',
      question_count: 2,
    } as AdminCampaignQuizPageResponse;

    const result = await campaignQuizGooglebotService.inspect(page);

    expect(fetchMock).toHaveBeenCalledWith(page.preview_url, expect.objectContaining({
      headers: expect.objectContaining({
        'User-Agent': expect.stringContaining('Googlebot'),
      }),
    }));
    expect(result.status_code).toBe(200);
    expect(result.checks).toHaveLength(9);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.checks.at(-1)?.detail).toBe('2 of 2 question headings found');
  });

  it('rejects a non-HTML preview response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(campaignQuizGooglebotService.inspect({
      slug: 'liverpool',
      preview_url: 'http://localhost:3011/en/football-quiz/liverpool?preview=token',
    } as AdminCampaignQuizPageResponse)).rejects.toThrow(/did not return HTML/);
  });
});
