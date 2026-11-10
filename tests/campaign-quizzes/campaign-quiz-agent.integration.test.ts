import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAMPAIGN_QUIZ_LOCALES, EDITION_LOCALES, EDITION_TEXT_FIELDS } from '../../src/modules/campaign-quizzes/campaign-quizzes.editions.js';
import { campaignQuizzesRepo, type CampaignQuizAgentCommitInput } from '../../src/modules/campaign-quizzes/campaign-quizzes.repo.js';

const target = process.env.CAMPAIGN_AGENT_TEST_DATABASE_URL;
const suite = target ? describe : describe.skip;

const USER = '00000000-0000-0000-0000-00000000a6e1';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const DIFFICULTIES = ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard'] as const;
const questions = (from: number) => DIFFICULTIES.map((difficulty, index) => ({ id: id(from + index), difficulty }));
const slugs = (base: string) => Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, locale === 'en' || locale === 'ka' ? base : `${locale}-${base}`])) as Record<(typeof CAMPAIGN_QUIZ_LOCALES)[number], string>;

const localeColumns = EDITION_LOCALES.flatMap((locale) => [
  ...EDITION_TEXT_FIELDS.map((field) => `${locale}_${field} text`),
  `${locale}_about_blocks jsonb`,
]).join(',\n  ');

const BASE_SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE TABLE users (id uuid PRIMARY KEY, nickname text);
CREATE FUNCTION trigger_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, name jsonb, is_active boolean DEFAULT true,
  campaign_only boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE questions (id uuid PRIMARY KEY, category_id uuid, type text, difficulty text, status text, prompt jsonb, explanation jsonb,
  ranked_eligible boolean NOT NULL DEFAULT true, visibility text NOT NULL DEFAULT 'public', created_by uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE question_payloads (question_id uuid PRIMARY KEY REFERENCES questions(id), payload jsonb, updated_at timestamptz DEFAULT now());
CREATE TABLE campaign_quizzes (
  slug text PRIMARY KEY, title text NOT NULL, status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), internal_name text NOT NULL, page_category text NOT NULL DEFAULT 'team',
  question_set_slug text NOT NULL, h1 text NOT NULL, lede text, about_heading text, about_blocks jsonb NOT NULL DEFAULT '[]',
  score_cta text, footer_banner_text text, footer_button_label text NOT NULL DEFAULT 'Play Ranked', hero_image_url text,
  hero_image_alt text, seo_title text NOT NULL, meta_description text, og_image_url text, og_image_alt text,
  breadcrumb_label text NOT NULL, locale_mode text NOT NULL DEFAULT 'en_only', scheduled_publish_at timestamptz,
  published_at timestamptz, unpublished_at timestamptz, preview_token uuid NOT NULL DEFAULT gen_random_uuid(),
  hub_order integer NOT NULL DEFAULT 0, created_by uuid, updated_by uuid, question_source text NOT NULL DEFAULT 'existing',
  is_hub_pinned boolean NOT NULL DEFAULT false,
  ${localeColumns}
);
CREATE TRIGGER trg_campaign_quizzes_set_updated_at BEFORE UPDATE ON campaign_quizzes FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TABLE campaign_quiz_questions (quiz_slug text NOT NULL REFERENCES campaign_quizzes(slug) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id), difficulty text NOT NULL, display_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (quiz_slug, question_id), UNIQUE (quiz_slug, display_order), UNIQUE (question_id));
CREATE FUNCTION reserve_campaign_quiz_question() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN UPDATE questions SET ranked_eligible = false WHERE id = NEW.question_id; RETURN NEW; END $f$;
CREATE TRIGGER trg_reserve_campaign_quiz_question AFTER INSERT OR UPDATE OF question_id ON campaign_quiz_questions
  FOR EACH ROW EXECUTE FUNCTION reserve_campaign_quiz_question();
CREATE TABLE campaign_quiz_revisions (id bigserial PRIMARY KEY, quiz_slug text NOT NULL, revision_number integer NOT NULL,
  action text NOT NULL, snapshot jsonb NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE campaign_quiz_routes (old_slug text PRIMARY KEY, status_code smallint NOT NULL, target_slug text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE campaign_quiz_related_pages (quiz_slug text NOT NULL, related_slug text NOT NULL, display_order smallint NOT NULL);
CREATE TABLE campaign_quiz_manual_questions (question_id uuid PRIMARY KEY, quiz_slug text NOT NULL);
`;

function commitInput(overrides: Partial<CampaignQuizAgentCommitInput> = {}): CampaignQuizAgentCommitInput {
  const english = Object.fromEntries(EDITION_TEXT_FIELDS.map((field) => [field, `en ${field}`])) as CampaignQuizAgentCommitInput['english'];
  english.about_blocks = [{ id: 'intro', type: 'paragraph', text: 'en body' }];
  const editions: Record<string, unknown> = {};
  for (const locale of EDITION_LOCALES) {
    for (const field of EDITION_TEXT_FIELDS) editions[`${locale}_${field}`] = `${locale} ${field}`;
    editions[`${locale}_about_blocks`] = [{ id: 'intro', type: 'paragraph', text: `${locale} body` }];
  }
  return {
    idempotencyKey: `test:${Math.random().toString(36).slice(2)}-0000000000`,
    action: 'create',
    slug: 'northwick',
    expectedVersion: null,
    internalName: 'Northwick Rovers',
    category: 'team',
    english,
    editions: editions as CampaignQuizAgentCommitInput['editions'],
    heroImageUrl: 'campaign-quizzes/northwick.webp',
    ogImageUrl: null,
    publicSlugs: slugs('northwick'),
    questions: questions(1),
    relatedSlugs: null,
    nextRefreshAt: '2099-01-01T00:00:00.000Z',
    userId: USER,
    revisionSnapshot: () => ({ questions: [] }),
    requestHash: 'a'.repeat(64),
    verify: () => [],
    ...overrides,
  };
}

suite('quiz-page agent writes (isolated local Postgres)', () => {
  let db: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = new URL(target!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rehearsal_')) {
      throw new Error('These tests need an isolated local rehearsal database');
    }
    if (process.env.DATABASE_URL !== target) throw new Error('Repository and fixture must use the same database');
    db = postgres(target!, { max: 2, onnotice: () => {} });
    await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.unsafe(BASE_SCHEMA);
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter((name) => /^2026111012\d{4}_campaign_quiz_.*\.sql$/.test(name)).sort()) {
      await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
    }
  });

  beforeEach(async () => {
    await db.unsafe(`TRUNCATE campaign_quiz_agent_commits, campaign_quiz_revisions, campaign_quiz_routes, campaign_quiz_related_pages,
      campaign_quiz_set_versions, campaign_quiz_slugs, campaign_quiz_questions, campaign_quizzes, question_payloads, questions CASCADE`);
    for (let n = 1; n <= 30; n += 1) {
      const text = (en: string) => Object.fromEntries(CAMPAIGN_QUIZ_LOCALES.map((locale) => [locale, `${locale} ${en}`]));
      await db`INSERT INTO questions (id, type, difficulty, status, prompt, explanation)
        VALUES (${id(n)}, 'mcq_single', 'easy', 'published', ${db.json(text(`q${n}`))}, ${db.json(text(`e${n}`))})`;
      await db`INSERT INTO question_payloads (question_id, payload) VALUES (${id(n)}, ${db.json({ type: 'mcq_single', options: [] })})`;
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  it('creates a page with every language, URL, question, version, revision and ledger entry in one go', async () => {
    expect(await campaignQuizzesRepo.agentCommit(commitInput())).toMatchObject({ kind: 'committed' });
    const [page] = await db`SELECT status, managed_by, version, fr_lede, locale_mode, next_refresh_at, content_modified_at FROM campaign_quizzes`;
    expect(page).toMatchObject({ status: 'published', managed_by: 'agent', fr_lede: 'fr lede', locale_mode: 'en_ka' });
    expect(page.content_modified_at).not.toBeNull();
    expect(await db`SELECT locale, public_slug FROM campaign_quiz_slugs ORDER BY locale`).toHaveLength(8);
    const [set] = await db`SELECT version, jsonb_array_length(questions) AS count FROM campaign_quiz_set_versions`;
    expect(set).toMatchObject({ version: 1, count: 10 });
    expect((await db`SELECT count(*)::int AS n FROM questions WHERE ranked_eligible = false`)[0].n).toBe(10);
    expect((await db`SELECT action FROM campaign_quiz_revisions`).map((row) => row.action)).toEqual(['published']);
    expect((await db`SELECT action FROM campaign_quiz_agent_commits`).map((row) => row.action)).toEqual(['create']);
  });

  it('replays a retried key without writing again, and refuses a second create of the same slug', async () => {
    const input = commitInput();
    await campaignQuizzesRepo.agentCommit(input);
    expect(await campaignQuizzesRepo.agentCommit(input)).toMatchObject({ kind: 'replayed', slug: 'northwick', action: 'create' });
    await expect(campaignQuizzesRepo.agentCommit({ ...input, requestHash: 'b'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
    await expect(campaignQuizzesRepo.agentCommit(commitInput())).rejects.toMatchObject({ statusCode: 409 });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_revisions`)[0].n).toBe(1);
  });

  it('rotates questions as a new set version and moves the content date; a stale or locked refresh writes nothing', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    const [{ version, content_modified_at: before }] = await db`SELECT version, content_modified_at FROM campaign_quizzes`;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rotated = [...questions(1).slice(0, 6), ...questions(11).slice(6)];
    await expect(campaignQuizzesRepo.agentCommit(commitInput({ action: 'refresh', expectedVersion: version - 1, questions: rotated })))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_set_versions`)[0].n).toBe(1);

    await campaignQuizzesRepo.agentCommit(commitInput({ action: 'refresh', expectedVersion: version, questions: rotated }));
    const versions = await db`SELECT version, questions->9->>'question_id' AS last FROM campaign_quiz_set_versions ORDER BY version`;
    expect(versions.map((row) => row.last)).toEqual([id(10), id(20)]);
    const [after] = await db`SELECT version, content_modified_at FROM campaign_quizzes`;
    expect(after.content_modified_at.getTime()).toBeGreaterThan(before.getTime());

    await db`UPDATE campaign_quizzes SET agent_locked = true`;
    const [{ version: locked }] = await db`SELECT version FROM campaign_quizzes`;
    await expect(campaignQuizzesRepo.agentCommit(commitInput({ action: 'refresh', expectedVersion: locked, questions: questions(1) })))
      .rejects.toMatchObject({ statusCode: 409, details: { reason: 'locked' } });
  });

  it('a recheck that fails inside the transaction writes nothing; two identical requests at once write once', async () => {
    await expect(campaignQuizzesRepo.agentCommit(commitInput({ verify: () => ['fr question changed'] })))
      .rejects.toMatchObject({ statusCode: 422 });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quizzes`)[0].n).toBe(0);

    const input = commitInput();
    const results = await Promise.all([campaignQuizzesRepo.agentCommit(input), campaignQuizzesRepo.agentCommit(input)]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'replayed']);
    const [{ version }] = await db`SELECT version FROM campaign_quizzes`;
    expect(results.find((result) => result.kind === 'committed')).toMatchObject({ version });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_revisions`)[0].n).toBe(1);
  });

  it('a review with no change moves only the review dates, never the content date', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    const [page] = await db`SELECT version, content_modified_at FROM campaign_quizzes`;
    await campaignQuizzesRepo.agentReview({ idempotencyKey: 'test:review-000000000001', requestHash: 'c'.repeat(64), slug: 'northwick', expectedVersion: page.version, nextRefreshAt: '2099-02-01T00:00:00.000Z' });
    const [after] = await db`SELECT content_modified_at, next_refresh_at FROM campaign_quizzes`;
    expect(after.content_modified_at.getTime()).toBe(page.content_modified_at.getTime());
    expect(after.next_refresh_at.toISOString()).toBe('2099-02-01T00:00:00.000Z');
  });

  it('refuses questions another page holds and URLs another page answers to, leaving nothing behind', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    await expect(campaignQuizzesRepo.agentCommit(commitInput({ slug: 'southby', publicSlugs: slugs('southby') })))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(campaignQuizzesRepo.agentCommit(commitInput({
      slug: 'southby',
      publicSlugs: { ...slugs('southby'), fr: 'fr-northwick' },
      questions: questions(11),
    }))).rejects.toMatchObject({ statusCode: 409 });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quizzes WHERE slug = 'southby'`)[0].n).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_slugs WHERE quiz_slug = 'southby'`)[0].n).toBe(0);
  });

  it('a CMS save over a newer version is refused; a save writes the languages it carries and keeps published URLs', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    const [{ version }] = await db`SELECT version FROM campaign_quizzes`;
    const form = {
      internal_name: 'Northwick Rovers', slug: 'northwick', category: 'team' as const, h1: 'en h1', lede: 'en lede',
      question_source: 'existing' as const, question_set_slug: 'northwick', manual_questions: [], about_heading: 'en about',
      about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: 'en body' }], score_cta: 'en {score}',
      footer_banner_text: 'en banner', footer_button_label: 'en play', related_slugs: [], hero_image_url: 'campaign-quizzes/northwick.webp',
      hero_image_alt: 'en alt', seo_title: 'en seo', meta_description: 'en meta', og_image_url: null, og_image_alt: null,
      breadcrumb_label: 'en label', locale_mode: 'en_ka' as const,
    };
    await expect(campaignQuizzesRepo.updateAdminPage('northwick', form, USER, { expectedVersion: version - 1 }))
      .rejects.toMatchObject({ statusCode: 409 });

    await campaignQuizzesRepo.updateAdminPage('northwick', form, USER, {
      expectedVersion: version,
      editions: { fr_h1: 'Quiz Northwick', fr_lede: 'Nouveau chapeau' },
    });
    const [page] = await db`SELECT fr_h1, fr_lede, fr_seo_title, de_h1 FROM campaign_quizzes`;
    expect(page).toEqual({ fr_h1: 'Quiz Northwick', fr_lede: 'Nouveau chapeau', fr_seo_title: 'fr seo_title', de_h1: 'de h1' });

    const [{ version: next }] = await db`SELECT version FROM campaign_quizzes`;
    await expect(campaignQuizzesRepo.updateAdminPage('northwick', form, USER, { expectedVersion: next, publicSlugs: { fr: 'quiz-northwick' } }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await db`SELECT public_slug FROM campaign_quiz_slugs WHERE locale = 'fr'`)[0].public_slug).toBe('fr-northwick');
  });

  it('refuses an old CMS save at the row lock, keeps a deleted page\'s localized URLs answering, dates related-link changes', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    const form = {
      internal_name: 'Northwick Rovers', slug: 'northwick', category: 'team' as const, h1: 'en h1', lede: 'en lede',
      question_source: 'existing' as const, question_set_slug: 'northwick', manual_questions: [], about_heading: 'en about',
      about_blocks: [{ id: 'intro', type: 'paragraph' as const, text: 'en body' }], score_cta: 'en {score}',
      footer_banner_text: 'en banner', footer_button_label: 'en play', related_slugs: [], hero_image_url: 'campaign-quizzes/northwick.webp',
      hero_image_alt: 'en alt', seo_title: 'en seo', meta_description: 'en meta', og_image_url: null, og_image_alt: null,
      breadcrumb_label: 'en label', locale_mode: 'en_ka' as const,
    };
    await expect(campaignQuizzesRepo.updateAdminPage('northwick', form, USER)).rejects.toMatchObject({ statusCode: 409 });

    await campaignQuizzesRepo.agentCommit(commitInput({ slug: 'southby', publicSlugs: slugs('southby'), questions: questions(11) }));
    const [{ content_modified_at: before }] = await db`SELECT content_modified_at FROM campaign_quizzes WHERE slug = 'northwick'`;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [{ version }] = await db`SELECT version FROM campaign_quizzes WHERE slug = 'northwick'`;
    await campaignQuizzesRepo.agentCommit(commitInput({ action: 'refresh', expectedVersion: version, relatedSlugs: ['southby'] }));
    const [{ content_modified_at: after }] = await db`SELECT content_modified_at FROM campaign_quizzes WHERE slug = 'northwick'`;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    await db`DELETE FROM campaign_quiz_related_pages`;
    await campaignQuizzesRepo.retire('southby', { route_mode: 'gone' } as never, USER, true);
    const routes = await db`SELECT old_slug, status_code FROM campaign_quiz_routes ORDER BY old_slug`;
    expect(routes.map((route) => route.old_slug)).toEqual(expect.arrayContaining(['southby', 'fr-southby', 'tr-southby']));
    expect(routes.every((route) => route.status_code === 410)).toBe(true);
  });

  it('keeps a version per real set change only, and a deleted page takes its versions and URLs with it', async () => {
    await campaignQuizzesRepo.agentCommit(commitInput());
    await db.begin(async (tx) => {
      await tx`DELETE FROM campaign_quiz_questions WHERE quiz_slug = 'northwick'`;
      for (const [index, question] of questions(1).entries()) {
        await tx`INSERT INTO campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
          VALUES ('northwick', ${question.id}, ${question.difficulty}, ${index + 1})`;
      }
    });
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_set_versions`)[0].n).toBe(1);
    await db`DELETE FROM campaign_quizzes WHERE slug = 'northwick'`;
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_set_versions`)[0].n).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM campaign_quiz_slugs`)[0].n).toBe(0);
  });
});
