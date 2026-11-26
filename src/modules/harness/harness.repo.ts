import { config } from '../../core/config.js';
import { sql } from '../../db/index.js';
import { MCQ_VALIDATION_CONDITIONS, RANKED_MIN_MCQ_QUESTIONS } from '../../db/sql-fragments.js';

type Db = typeof sql;

/** The questions ranked can draw (same filters as lobbiesRepo.listAllRankedEligibleCategories). */
const RANKED_USABLE = sql`q.status = 'published' AND q.visibility = 'public' AND q.ranked_eligible = true`;

// Read side of the new HQ harness (`harness` schema, migration
// 20261125120000_harness_core.sql) for the CMS Content tab. The harness worker
// (quizball-question-agents, pm2 app harness-worker) does all the writing
// except the owner controls below.

export interface HarnessSettingsRow {
  paused: boolean;
  paused_reason: string | null;
  max_concurrent_runs: number;
  daily_run_limit: number;
  updated_at: Date | string;
}

export const harnessRepo = {
  async settings(): Promise<HarnessSettingsRow> {
    const [row] = await sql<HarnessSettingsRow[]>`SELECT paused, paused_reason, max_concurrent_runs, daily_run_limit, updated_at FROM harness.settings WHERE id`;
    return row;
  },

  async updateSettings(patch: { paused?: boolean; paused_reason?: string | null; max_concurrent_runs?: number; daily_run_limit?: number }): Promise<HarnessSettingsRow> {
    const [row] = await sql<HarnessSettingsRow[]>`
      UPDATE harness.settings SET
        paused = coalesce(${patch.paused ?? null}::boolean, paused),
        paused_reason = CASE WHEN ${patch.paused_reason !== undefined} THEN ${patch.paused_reason ?? null} ELSE paused_reason END,
        max_concurrent_runs = coalesce(${patch.max_concurrent_runs ?? null}::integer, max_concurrent_runs),
        daily_run_limit = coalesce(${patch.daily_run_limit ?? null}::integer, daily_run_limit),
        updated_at = now()
      WHERE id
      RETURNING paused, paused_reason, max_concurrent_runs, daily_run_limit, updated_at`;
    return row;
  },

  async accounts() {
    // secret_ref is only the name of an environment variable on the worker, never the secret.
    return sql<
      Array<{ id: string; provider: string; label: string; secret_ref: string; status: string; reserved_for_people: boolean; soft_pct: number; state: string; blocked_until: Date | null; windows: unknown; last_error: string | null }>
    >`SELECT id, provider, label, secret_ref, status, reserved_for_people, soft_pct, state, blocked_until, windows, last_error FROM harness.accounts ORDER BY reserved_for_people, id`;
  },

  async agents() {
    return sql<
      Array<{ slug: string; name: string; team: string; description: string; provider: string; model: string; effort: string | null; primary_account: string; fallback_accounts: string[]; status: string; runs_today: string; cost_cents_today: string | null; last_run_at: Date | null }>
    >`
      SELECT a.slug, a.name, a.team, a.description, a.provider, a.model, a.effort, a.primary_account, a.fallback_accounts, a.status,
             count(r.id) FILTER (WHERE r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi') AS runs_today,
             sum(r.cost_cents) FILTER (WHERE r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi') AS cost_cents_today,
             (SELECT max(lr.started_at) FROM harness.runs lr WHERE lr.agent_slug = a.slug) AS last_run_at
        FROM harness.agents a
        LEFT JOIN harness.runs r ON r.agent_slug = a.slug AND r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'
       GROUP BY a.slug
       ORDER BY a.team, a.slug`;
  },

  async classicHealth(cap: number) {
    return sql<Array<{ category_id: string; slug: string; views_30d: string; pool: string; in_pipeline: string; needed: string; shortage: string }>>`
      SELECT * FROM harness.classic_health(${cap})`;
  },

  async classicCap(): Promise<number> {
    const [row] = await sql<Array<{ cap: number | null }>>`
      SELECT (body -> 'ranked' ->> 'view_cap_30d')::integer AS cap FROM harness.contracts WHERE mode = 'classic' AND active`;
    return row?.cap ?? 100;
  },

  async stageCounts() {
    return sql<Array<{ mode: string; stage: string; n: string }>>`SELECT mode, stage, count(*) AS n FROM harness.items GROUP BY 1, 2 ORDER BY 1, 2`;
  },

  async jobCounts() {
    return sql<Array<{ kind: string; status: string; n: string }>>`
      SELECT kind, status, count(*) AS n FROM harness.jobs
       WHERE status IN ('queued', 'running') OR finished_at > now() - interval '24 hours'
       GROUP BY 1, 2 ORDER BY 1, 2`;
  },

  async recentRuns(limit = 25) {
    return sql<Array<{ id: string; agent_slug: string; account_id: string | null; model: string; status: string; tokens_in: number; tokens_out: number; cost_cents: number; error: string | null; started_at: Date; ended_at: Date | null }>>`
      SELECT id, agent_slug, account_id, model, status, tokens_in, tokens_out, cost_cents, error, started_at, ended_at
        FROM harness.runs ORDER BY started_at DESC LIMIT ${limit}`;
  },

  async recentEvents(limit = 40) {
    return sql<Array<{ id: string; type: string; level: string; message: string; item_id: string | null; created_at: Date; category_id: string | null; prompt: string | null }>>`
      SELECT e.id, e.type, e.level, e.message, e.item_id, e.created_at, i.category_id, left(i.payload #>> '{prompt,en}', 140) AS prompt
        FROM harness.events e LEFT JOIN harness.items i ON i.id = e.item_id
       ORDER BY e.id DESC LIMIT ${limit}`;
  },

  async policies() {
    return sql<Array<{ key: string; value: unknown; note: string; updated_at: Date }>>`SELECT key, value, note, updated_at FROM harness.policies ORDER BY key`;
  },

  async setPolicy(key: string, value: unknown): Promise<boolean> {
    const rows = await sql`UPDATE harness.policies SET value = ${sql.json(value as never)}, updated_at = now() WHERE key = ${key} RETURNING key`;
    return rows.length === 1;
  },

  async todayTotals() {
    const [row] = await sql<Array<{ runs: string; cost_cents: string | null; failed: string }>>`
      SELECT count(*) AS runs, sum(cost_cents) AS cost_cents, count(*) FILTER (WHERE status IN ('failed', 'timeout')) AS failed
        FROM harness.runs
       WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'`;
    return row;
  },

  // ── steering (Content tab) ─────────────────────────────────────────────────

  async categoryNames(ids: string[]) {
    if (!ids.length) return [];
    return sql<Array<{ id: string; name: string | null }>>`
      SELECT id, coalesce(name ->> 'en', slug) AS name FROM public.categories WHERE id = ANY(${ids}::uuid[])`;
  },

  async steering() {
    return sql<Array<{ category_id: string; priority: string; direction: string; updated_by: string | null; updated_at: Date }>>`
      SELECT category_id, priority, direction, updated_by, updated_at FROM harness.steering`;
  },

  async setSteering(categoryId: string, patch: { priority?: string; direction?: string }, by: string) {
    const [row] = await sql<Array<{ category_id: string; priority: string; direction: string; updated_at: Date }>>`
      INSERT INTO harness.steering (category_id, priority, direction, updated_by)
      VALUES (${categoryId}, ${patch.priority ?? 'normal'}, ${patch.direction ?? ''}, ${by})
      ON CONFLICT (category_id) DO UPDATE SET
        priority = coalesce(${patch.priority ?? null}::text, harness.steering.priority),
        direction = coalesce(${patch.direction ?? null}::text, harness.steering.direction),
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING category_id, priority, direction, updated_at`;
    return row;
  },

  async activeCategories() {
    return sql<Array<{ id: string; name: string }>>`
      SELECT id, coalesce(name ->> 'en', slug) AS name FROM public.categories WHERE is_active ORDER BY 2`;
  },

  async categoryExists(categoryId: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM public.categories WHERE id = ${categoryId}`;
    return rows.length === 1;
  },

  /** Questions that reached the game per category in the last 7 days: the fill rate. */
  async liveLast7d() {
    return sql<Array<{ category_id: string; n: string }>>`
      SELECT category_id, count(*) AS n FROM harness.items
       WHERE stage = 'live' AND released_at > now() - interval '7 days' AND category_id IS NOT NULL
       GROUP BY 1`;
  },

  async liveToday(): Promise<number> {
    const [row] = await sql<Array<{ n: string }>>`
      SELECT count(*) AS n FROM harness.items
       WHERE stage = 'live' AND released_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'`;
    return Number(row?.n ?? 0);
  },

  async needsYou(limit = 30) {
    return sql<Array<{ id: string; category_id: string | null; difficulty: string; payload: unknown; last_issues: unknown; revise_count: number; version: number; updated_at: Date }>>`
      SELECT id, category_id, difficulty, payload, last_issues, revise_count, version, updated_at
        FROM harness.items WHERE stage = 'escalated' ORDER BY updated_at DESC LIMIT ${limit}`;
  },

  async recentLive(limit = 20) {
    return sql<Array<{ id: string; category_id: string | null; difficulty: string; payload: unknown; question_id: string | null; released_at: Date | null; version: number }>>`
      SELECT id, category_id, difficulty, payload, question_id, released_at, version
        FROM harness.items WHERE stage = 'live' ORDER BY released_at DESC NULLS LAST LIMIT ${limit}`;
  },

  async requests(limit = 20) {
    return sql<Array<{ id: string; category_id: string | null; difficulty: string; count: number; topic: string | null; deadline: string | null; requested_by: string | null; status: string; created_at: Date; live: string; working: string; dropped: string }>>`
      SELECT b.id, b.category_id, b.difficulty, b.count, b.topic, b.deadline::text AS deadline, b.requested_by, b.status, b.created_at,
             count(i.id) FILTER (WHERE i.stage = 'live') AS live,
             count(i.id) FILTER (WHERE i.stage IN ('draft', 'validated', 'verified', 'localized', 'approved')) AS working,
             count(i.id) FILTER (WHERE i.stage IN ('rejected', 'escalated', 'retired')) AS dropped
        FROM harness.briefs b LEFT JOIN harness.items i ON i.brief_id = b.id
       WHERE b.source = 'request' AND (b.status = 'open' OR b.created_at > now() - interval '14 days')
       GROUP BY b.id ORDER BY b.created_at DESC LIMIT ${limit}`;
  },

  /** A person's order: the brief and its planning job land together. Deadlines go first. */
  async createRequest(r: { categoryId: string; difficulty: string; count: number; topic: string; deadline: string | null; by: string }) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [contract] = await tx<Array<{ version: number }>>`SELECT version FROM harness.contracts WHERE mode = 'classic' AND active`;
      if (!contract) throw new Error('no active classic contract');
      const [brief] = await tx<Array<{ id: string }>>`
        INSERT INTO harness.briefs (mode, contract_version, category_id, difficulty, count, reason, source, topic, deadline, requested_by)
        VALUES ('classic', ${contract.version}, ${r.categoryId}, ${r.difficulty}, ${r.count},
                ${`ordered by ${r.by}: ${r.topic}`}, 'request', ${r.topic}, ${r.deadline}, ${r.by})
        RETURNING id`;
      const [agent] = await tx<Array<{ slug: string }>>`SELECT slug FROM harness.agents WHERE slug = 'content-planner'`;
      await tx`INSERT INTO harness.jobs (kind, agent_slug, brief_id, priority) VALUES ('plan', ${agent?.slug ?? 'content-planner'}, ${brief.id}, ${r.deadline ? 0 : 1})`;
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${r.by} ordered ${r.count} ${r.difficulty} questions: ${r.topic}`}, ${tx.json({ brief: brief.id })})`;
      return brief.id;
    });
  },

  async cancelRequest(briefId: string, by: string): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      // Jobs first, then the brief: the same order as finish_job -> job_gave_up, so the two can't deadlock.
      await tx`SELECT id FROM harness.jobs WHERE brief_id = ${briefId} AND status IN ('queued', 'running') ORDER BY id FOR UPDATE`;
      const rows = await tx`UPDATE harness.briefs SET status = 'cancelled', updated_at = now() WHERE id = ${briefId} AND source = 'request' AND status = 'open' RETURNING id`;
      if (rows.length !== 1) return false;
      await tx`UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = ${`cancelled by ${by}`}, lease_owner = NULL, lease_token = NULL, lease_until = NULL
                WHERE brief_id = ${briefId} AND status IN ('queued', 'running')`;
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${by} cancelled an order`}, ${tx.json({ brief: briefId })})`;
      return true;
    });
  },

  /**
   * A person's decision on one item, through the same compare-and-set
   * transition the agents use: a stale screen can never move an item twice.
   * Returns null when the item moved since it was read.
   */
  async itemAction(a: { itemId: string; version: number; action: 'flag' | 'approve' | 'reject' | 'send_back'; note: string; by: string }) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [it] = await tx<Array<{ stage: string; version: number; question_id: string | null }>>`
        SELECT stage, version, question_id FROM harness.items WHERE id = ${a.itemId} FOR UPDATE`;
      if (!it) return { ok: false as const, reason: 'not_found' };
      const from = a.action === 'flag' ? 'live' : 'escalated';
      if (it.stage !== from || it.version !== a.version) return { ok: false as const, reason: 'moved' };
      const issue = [{ field: 'editor', problem: a.note || a.action, by: a.by }];
      // Approving vouches for the English. An item stuck before translation still
      // goes through the translators; a translated one is ready to release.
      let untranslated = false;
      if (a.action === 'approve') {
        const [row] = await tx<Array<{ missing: number }>>`
          SELECT count(*)::int AS missing
            FROM harness.items i
            JOIN harness.contracts c ON c.mode = i.mode AND c.version = i.contract_version,
                 jsonb_array_elements_text(c.body -> 'locales') l
           WHERE i.id = ${a.itemId} AND coalesce(i.payload #>> ARRAY['prompt', l], '') = ''`;
        untranslated = (row?.missing ?? 0) > 0;
      }
      const to =
        a.action === 'flag' ? 'retired' : a.action === 'approve' ? (untranslated ? 'verified' : 'approved') : a.action === 'reject' ? 'rejected' : 'draft';
      const patch = a.action === 'send_back' ? { last_issues: issue, revise_count: 0 } : a.action === 'approve' ? { last_issues: [] } : { last_issues: issue };
      const jobs =
        a.action === 'send_back'
          ? [{ kind: 'make', agent_slug: 'question-maker', priority: 1, input: { revise: true, issues: issue } }]
          : a.action === 'approve' && untranslated
            ? [{ kind: 'localize', agent_slug: 'localizer', priority: 1, input: { attempt: 1 } }]
            : [];
      const moved = await tx`SELECT id FROM harness.transition(${a.itemId}, ${from}, ${a.version}, ${to}, ${tx.json(patch)}, ${tx.json(jobs as never)})`;
      if (moved.length !== 1) return { ok: false as const, reason: 'moved' };
      // A flagged question leaves ranked at once.
      if (a.action === 'flag' && it.question_id) await tx`UPDATE public.questions SET status = 'archived' WHERE id = ${it.question_id}`;
      await tx`INSERT INTO harness.events (type, message, item_id, data)
               VALUES ('editor', ${`${a.by}: ${a.action.replace('_', ' ')}${a.note ? ` (${a.note.slice(0, 200)})` : ''}`}, ${a.itemId}, ${tx.json({ action: a.action })})`;
      return { ok: true as const, stage: to };
    });
  },

  // ── phase 2: events, new categories, Ask HQ ────────────────────────────────

  async contentEvents(limit = 20) {
    return sql<Array<{ id: string; title: string; happens_on: string; notes: string; category_ids: string[]; per_category: number; difficulty: string; status: string; created_by: string | null; created_at: Date; live: string; working: string; dropped: string }>>`
      SELECT e.id, e.title, e.happens_on::text AS happens_on, e.notes, e.category_ids, e.per_category, e.difficulty, e.status, e.created_by, e.created_at,
             count(i.id) FILTER (WHERE i.stage = 'live') AS live,
             count(i.id) FILTER (WHERE i.stage IN ('draft', 'validated', 'verified', 'localized', 'approved')) AS working,
             count(i.id) FILTER (WHERE i.stage IN ('rejected', 'escalated', 'retired')) AS dropped
        FROM harness.content_events e
        LEFT JOIN harness.briefs b ON b.event_id = e.id
        LEFT JOIN harness.items i ON i.brief_id = b.id
       WHERE e.happens_on >= current_date - 7 OR e.created_at > now() - interval '14 days'
       GROUP BY e.id ORDER BY e.happens_on, e.created_at LIMIT ${limit}`;
  },

  /** An event becomes deadline briefs, one per category and difficulty, due the day before. */
  async createEvent(e: { title: string; happensOn: string; notes: string; categoryIds: string[]; perCategory: number; difficulty: string; by: string }) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [contract] = await tx<Array<{ version: number }>>`SELECT version FROM harness.contracts WHERE mode = 'classic' AND active`;
      if (!contract) throw new Error('no active classic contract');
      const [ev] = await tx<Array<{ id: string }>>`
        INSERT INTO harness.content_events (title, happens_on, notes, category_ids, per_category, difficulty, created_by)
        VALUES (${e.title}, ${e.happensOn}, ${e.notes}, ${e.categoryIds}::uuid[], ${e.perCategory}, ${e.difficulty}, ${e.by})
        RETURNING id`;
      const topic = `${e.title} (on ${e.happensOn})${e.notes ? `: ${e.notes}` : ''}`.slice(0, 300);
      for (const categoryId of e.categoryIds) {
        for (const [difficulty, count] of splitCount(e.perCategory, e.difficulty)) {
          const [brief] = await tx<Array<{ id: string }>>`
            INSERT INTO harness.briefs (mode, contract_version, category_id, difficulty, count, reason, source, topic, deadline, requested_by, event_id)
            VALUES ('classic', ${contract.version}, ${categoryId}, ${difficulty}, ${count}, ${`event: ${e.title}`}, 'event', ${topic},
                    (${e.happensOn}::date - 1), ${e.by}, ${ev.id})
            RETURNING id`;
          await tx`INSERT INTO harness.jobs (kind, agent_slug, brief_id, priority) VALUES ('plan', 'content-planner', ${brief.id}, 0)`;
        }
      }
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${e.by} added the event ${e.title} (${e.happensOn})`}, ${tx.json({ event: ev.id })})`;
      return ev.id;
    });
  },

  async cancelEvent(id: string, by: string): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      // Jobs, then briefs, then the event: the same order as the worker's finish path.
      await tx`SELECT j.id FROM harness.jobs j JOIN harness.briefs b ON b.id = j.brief_id
                WHERE b.event_id = ${id} AND j.status IN ('queued', 'running') ORDER BY j.id FOR UPDATE OF j`;
      const rows = await tx`UPDATE harness.content_events SET status = 'cancelled', updated_at = now() WHERE id = ${id} AND status = 'open' RETURNING id`;
      if (rows.length !== 1) return false;
      await cancelBriefs(tx, sql`event_id = ${id}`, by);
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${by} cancelled an event`}, ${tx.json({ event: id })})`;
      return true;
    });
  },

  async proposals(limit = 20) {
    return sql<Array<{ id: string; name: string; why: string; category_id: string | null; target: number; status: string; proposed_by: string | null; created_at: Date; is_active: boolean | null; live: string; working: string; put_in_order: string; clue_chain: string }>>`
      SELECT p.id, p.name, p.why, p.category_id, p.target, p.status, p.proposed_by, p.created_at, c.is_active,
             (SELECT count(*) FROM public.questions q WHERE q.category_id = p.category_id AND q.type = 'mcq_single' AND ${RANKED_USABLE}) AS live,
             (SELECT count(*) FROM public.questions q WHERE q.category_id = p.category_id AND q.type = 'put_in_order' AND ${RANKED_USABLE}) AS put_in_order,
             (SELECT count(*) FROM public.questions q WHERE q.category_id = p.category_id AND q.type = 'clue_chain' AND ${RANKED_USABLE}) AS clue_chain,
             (SELECT count(*) FROM harness.items i WHERE i.category_id = p.category_id AND i.stage IN ('draft', 'validated', 'verified', 'localized', 'approved')) AS working
        FROM harness.category_proposals p LEFT JOIN public.categories c ON c.id = p.category_id
       WHERE p.status = 'filling' OR p.updated_at > now() - interval '14 days'
       ORDER BY p.created_at DESC LIMIT ${limit}`;
  },

  /**
   * A new category: created hidden (not in the game), given the team's note as
   * its direction, and filled with a starter set. A person puts it live.
   */
  async createProposal(p: { name: string; why: string; target: number; by: string }) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [contract] = await tx<Array<{ version: number }>>`SELECT version FROM harness.contracts WHERE mode = 'classic' AND active`;
      if (!contract) throw new Error('no active classic contract');
      const base = slugify(p.name) || 'category';
      const taken = new Set((await tx<Array<{ slug: string }>>`SELECT slug FROM public.categories WHERE slug = ${base} OR slug LIKE ${`${base}-%`}`).map((r) => r.slug));
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      const [cat] = await tx<Array<{ id: string }>>`
        INSERT INTO public.categories (slug, name, is_active) VALUES (${slug}, ${tx.json({ en: p.name })}, false) RETURNING id`;
      const [prop] = await tx<Array<{ id: string }>>`
        INSERT INTO harness.category_proposals (name, why, category_id, target, proposed_by)
        VALUES (${p.name}, ${p.why}, ${cat.id}, ${p.target}, ${p.by}) RETURNING id`;
      if (p.why) await tx`INSERT INTO harness.steering (category_id, direction, updated_by) VALUES (${cat.id}, ${p.why.slice(0, 1000)}, ${p.by})`;
      const topic = `starter set for the new category "${p.name}": the core facts, people and moments its fans know`;
      for (const [difficulty, total] of splitCount(p.target, 'mixed')) {
        for (let left = total; left > 0; left -= 20) {
          const [brief] = await tx<Array<{ id: string }>>`
            INSERT INTO harness.briefs (mode, contract_version, category_id, difficulty, count, reason, source, topic, requested_by, proposal_id)
            VALUES ('classic', ${contract.version}, ${cat.id}, ${difficulty}, ${Math.min(20, left)}, ${`new category: ${p.name}`}, 'seed', ${topic}, ${p.by}, ${prop.id})
            RETURNING id`;
          await tx`INSERT INTO harness.jobs (kind, agent_slug, brief_id, priority) VALUES ('plan', 'content-planner', ${brief.id}, 1)`;
        }
      }
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${p.by} suggested a new category: ${p.name}`}, ${tx.json({ proposal: prop.id })})`;
      return { id: prop.id, categoryId: cat.id, slug };
    });
  },

  /**
   * Puts a filled category into the game. Ranked only picks a category with
   * at least one put-in-order and one clue-chain question besides the
   * multiple choice ones, so it waits until those exist.
   */
  async proposalGoLive(id: string, by: string): Promise<boolean | 'missing_special' | 'missing_mcq'> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [need] = await tx<Array<{ mcq: boolean; specials: boolean }>>`
        SELECT (SELECT count(*) FROM public.questions q JOIN public.question_payloads qp ON qp.question_id = q.id
                 WHERE q.category_id = p.category_id AND ${RANKED_USABLE} AND ${MCQ_VALIDATION_CONDITIONS}) >= ${RANKED_MIN_MCQ_QUESTIONS} AS mcq,
               (SELECT count(*) FROM public.questions q WHERE q.category_id = p.category_id AND q.type = 'put_in_order' AND ${RANKED_USABLE}) >= 1
           AND (SELECT count(*) FROM public.questions q WHERE q.category_id = p.category_id AND q.type = 'clue_chain' AND ${RANKED_USABLE}) >= 1 AS specials
          FROM harness.category_proposals p WHERE p.id = ${id}`;
      // The same minimums ranked applies (sql-fragments): MCQs always; the special types except in MCQ-only seasons.
      if (need && !need.mcq) return 'missing_mcq';
      if (need && !need.specials && !config.POSSESSION_MCQ_ONLY) return 'missing_special';
      const [p] = await tx<Array<{ category_id: string | null; name: string }>>`
        UPDATE harness.category_proposals SET status = 'live', updated_at = now() WHERE id = ${id} AND status = 'filling' AND category_id IS NOT NULL
        RETURNING category_id, name`;
      if (!p) return false;
      await tx`UPDATE public.categories SET is_active = true, updated_at = now() WHERE id = ${p.category_id}`;
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${by} put the new category ${p.name} live`}, ${tx.json({ proposal: id })})`;
      return true;
    });
  },

  async cancelProposal(id: string, by: string): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      await tx`SELECT j.id FROM harness.jobs j JOIN harness.briefs b ON b.id = j.brief_id
                WHERE b.proposal_id = ${id} AND j.status IN ('queued', 'running') ORDER BY j.id FOR UPDATE OF j`;
      const rows = await tx`UPDATE harness.category_proposals SET status = 'cancelled', updated_at = now() WHERE id = ${id} AND status = 'filling' RETURNING id`;
      if (rows.length !== 1) return false;
      await cancelBriefs(tx, sql`proposal_id = ${id}`, by);
      await tx`INSERT INTO harness.events (type, message, data) VALUES ('request', ${`${by} dropped a suggested category`}, ${tx.json({ proposal: id })})`;
      return true;
    });
  },

  async asks(limit = 10) {
    return sql<Array<{ id: string; message: string; asked_by: string | null; status: string; reply: string | null; actions: unknown; applied: unknown; error: string | null; applied_by: string | null; created_at: Date }>>`
      SELECT id, message, asked_by, status, reply, actions, applied, error, applied_by, created_at FROM harness.asks ORDER BY created_at DESC LIMIT ${limit}`;
  },

  async createAsk(message: string, by: string) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [ask] = await tx<Array<{ id: string }>>`INSERT INTO harness.asks (message, asked_by) VALUES (${message}, ${by}) RETURNING id`;
      await tx`INSERT INTO harness.jobs (kind, agent_slug, ask_id, priority) VALUES ('ask', 'hq-assistant', ${ask.id}, 0)`;
      return ask.id;
    });
  },

  /** Takes an answered ask for applying: only one person can apply it, once. */
  async claimAsk(id: string, by: string) {
    const [row] = await sql<Array<{ actions: unknown }>>`
      UPDATE harness.asks SET status = 'applied', applied_by = ${by}, updated_at = now() WHERE id = ${id} AND status = 'answered' RETURNING actions`;
    return row ?? null;
  },

  async recordAskApplied(id: string, applied: unknown) {
    await sql`UPDATE harness.asks SET applied = ${sql.json(applied as never)}, updated_at = now() WHERE id = ${id}`;
  },

  async dismissAsk(id: string): Promise<boolean> {
    const rows = await sql`UPDATE harness.asks SET status = 'dismissed', updated_at = now() WHERE id = ${id} AND status IN ('answered', 'failed', 'thinking') RETURNING id`;
    if (rows.length === 1) await sql`UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE ask_id = ${id} AND status = 'queued'`;
    return rows.length === 1;
  },
};

/** Splits a question count by difficulty: one band, or the ranked mix (40/40/20) for 'mixed'. */
export function splitCount(total: number, difficulty: string): Array<[string, number]> {
  if (difficulty !== 'mixed') return [[difficulty, total]];
  const easy = Math.round(total * 0.4);
  const medium = Math.round(total * 0.4);
  const hard = total - easy - medium;
  return ([['easy', easy], ['medium', medium], ['hard', hard]] as Array<[string, number]>).filter(([, n]) => n > 0);
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Cancels the open briefs matching `where` and their unfinished jobs (their leases are cleared, so late results are refused). */
async function cancelBriefs(tx: Db, where: ReturnType<typeof sql>, by: string) {
  const briefs = await tx<Array<{ id: string }>>`UPDATE harness.briefs SET status = 'cancelled', updated_at = now() WHERE ${where} AND status = 'open' RETURNING id`;
  const ids = briefs.map((b) => b.id);
  if (ids.length)
    await tx`UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = ${`cancelled by ${by}`}, lease_owner = NULL, lease_token = NULL, lease_until = NULL
              WHERE brief_id = ANY(${ids}::uuid[]) AND status IN ('queued', 'running')`;
}
