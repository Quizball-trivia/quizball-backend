// Days of unrepeated daily content per challenge type (read-only).
// Usage: node scripts/daily-content-audit/content_days.mjs <db_url>
import postgres from 'postgres';
const dbUrl = process.argv[2]; if (!dbUrl) throw new Error('db url required');
const sql = postgres(dbUrl, { prepare: false, max: 2 });
const QTYPE = { moneyDrop: 'mcq_single', trueFalse: 'true_false', countdown: 'countdown_list', clues: 'clue_chain', putInOrder: 'put_in_order', imposter: 'imposter_multi_select', careerPath: 'career_path', highLow: 'high_low', footballLogic: 'football_logic', missingXi: 'missing_xi', passChain: 'pass_chain', statSniper: 'stat_sniper' };
try {
  const configs = Object.fromEntries((await sql`select challenge_type, is_active, settings from daily_challenge_configs`).map((r) => [r.challenge_type, r]));
  const rows = [];
  for (const [ctype, qtype] of Object.entries(QTYPE)) {
    const cfg = configs[ctype]; const settings = cfg?.settings ?? {};
    const perDay = settings.questionCount || settings.roundCount || settings.matchCount || settings.puzzleCount || 0;
    const cats = settings.categoryIds ?? [];
    const [{ n }] = await sql`select count(*)::int n from questions q join categories c on c.id = q.category_id
      where q.status = 'published' and q.visibility = 'public' and q.ranked_eligible and q.type = ${qtype} and c.is_active
        and not exists (select 1 from featured_categories fc where fc.category_id = c.id)
        ${cats.length ? sql`and q.category_id = any(${cats}::uuid[])` : sql``}`;
    rows.push({ type: ctype, active: cfg ? cfg.is_active : null, per_day: perDay, pool: n, days: perDay ? Math.floor(n / perDay) : null });
  }
  const cd = configs.cardDetective;
  const hasSets = (await sql`select to_regclass('public.daily_card_detective_sets') t`)[0].t;
  if (hasSets) {
    const [{ ahead, last }] = await sql`select count(*)::int ahead, max(challenge_day)::text last from daily_card_detective_sets where challenge_day >= current_date`;
    const [{ pool }] = await sql`select count(*)::int pool from fifa_cards where is_active and not generator_retired`;
    rows.push({ type: 'cardDetective', active: cd ? cd.is_active : null, per_day: cd?.settings?.cardCount ?? 10, pool, days: ahead, note: `preallocated through ${last}` });
  } else rows.push({ type: 'cardDetective', active: cd ? cd.is_active : null, note: 'no sets table' });
  console.table(rows);
} finally { await sql.end(); }
