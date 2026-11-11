-- Cost Optimizer (founder, 2026-11-11): an agent that goes through what QuizBall pays for (invoices and usage of
-- servers, database, analytics, AI and the rest), finds where we spend more than we should, and brings Romero
-- concrete savings with the numbers.
--
-- hq.costs: one row per service, month and kind (an invoice total, an estimate, or measured usage). Written by the
-- founder (or with the founder's OK) from invoices and billing pages; agents only read it.
-- hq.cost_report(): the ledger plus what the database itself can measure (database and table sizes, file storage
-- per bucket, HQ's own agent runs) and the player numbers to put costs per player.

CREATE TABLE IF NOT EXISTS hq.costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL CHECK (length(service) BETWEEN 1 AND 60),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'estimate', 'usage')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  plan text CHECK (length(plan) <= 200),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  note text CHECK (length(note) <= 2000),
  source text CHECK (length(source) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service, month, kind)
);
ALTER TABLE hq.costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hq.costs FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON hq.costs FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON hq.costs FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON hq.costs TO service_role';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hq.cost_report(p_months integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '60s'
SET lock_timeout = '2s'
AS $$
DECLARE
  m integer := LEAST(GREATEST(COALESCE(p_months, 6), 1), 24);
  since date := (date_trunc('month', now() AT TIME ZONE 'Asia/Tbilisi') - make_interval(months => m - 1))::date;
  today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_storage jsonb := '[]'::jsonb;
  v_dau jsonb := '[]'::jsonb;
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COALESCE(jsonb_agg(b ORDER BY (b->>'bytes')::bigint DESC), '[]'::jsonb)
        FROM (SELECT jsonb_build_object('bucket', bucket_id, 'files', count(*),
                                        'bytes', COALESCE(sum((metadata->>'size')::bigint), 0),
                                        'added_30d_bytes', COALESCE(sum((metadata->>'size')::bigint) FILTER (WHERE created_at > now() - interval '30 days'), 0)) AS b
                FROM storage.objects GROUP BY bucket_id) x
    $q$ INTO v_storage;
  END IF;
  IF to_regprocedure('hq.active_identities_between(date,date)') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d, 'active_players', hq.active_identities_between(d, d)) ORDER BY d), '[]'::jsonb)
        FROM generate_series($1 - 7, $1 - 1, interval '1 day') AS g(dd), LATERAL (SELECT dd::date AS d) x
    $q$ INTO v_dau USING today;
  END IF;

  RETURN jsonb_build_object(
    'notes', jsonb_build_array(
      'ledger: what QuizBall paid or will pay per service and month (invoice = billed total, estimate = expected, usage = measured amounts in usage). Amounts in cents of the row''s currency.',
      'database/storage: measured now in the production database; Supabase bills database size and file storage above the plan''s included amounts.',
      'hq_agents: HQ''s own agent runs over 30 days; cost_cents is the API-equivalent price of the tokens (runs on the Claude subscription, so it shows load, not a bill).',
      'players: daily active players for the last 7 complete days, to put costs per player.'),
    'ledger', (SELECT COALESCE(jsonb_agg(jsonb_build_object('service', c.service, 'month', c.month, 'kind', c.kind,
                 'amount_cents', c.amount_cents, 'currency', c.currency, 'plan', c.plan, 'usage', c.usage, 'note', c.note,
                 'source', c.source) ORDER BY c.month DESC, c.amount_cents DESC), '[]'::jsonb)
                 FROM hq.costs c WHERE c.month >= since),
    'monthly_totals', (SELECT COALESCE(jsonb_agg(jsonb_build_object('month', t.month, 'currency', t.currency, 'kind', t.kind,
                 'amount_cents', t.total, 'services', t.n) ORDER BY t.month DESC, t.kind), '[]'::jsonb)
                 FROM (SELECT month, currency, kind, sum(amount_cents)::bigint AS total, count(*) AS n
                         FROM hq.costs WHERE month >= since GROUP BY 1, 2, 3) t),
    'database', jsonb_build_object(
       'bytes', pg_database_size(current_database()),
       'largest_tables', (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'total_bytes')::bigint DESC), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('table', n.nspname || '.' || c.relname,
                   'total_bytes', pg_total_relation_size(c.oid), 'table_bytes', pg_relation_size(c.oid),
                   'index_bytes', pg_indexes_size(c.oid), 'rows_estimate', GREATEST(c.reltuples, 0)::bigint) AS x
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'm', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
           ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20) t)),
    'storage', v_storage,
    'hq_agents', (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'cost_cents')::bigint DESC), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('agent', COALESCE(mb.name, '?'), 'runs', count(*),
                   'cost_cents', COALESCE(sum(r.cost_cents), 0), 'tokens_in', COALESCE(sum(r.tokens_in), 0),
                   'tokens_out', COALESCE(sum(r.tokens_out), 0)) AS x
            FROM hq.runs r LEFT JOIN hq.members mb ON mb.id = r.member_id
           WHERE r.started_at > now() - interval '30 days'
           GROUP BY mb.name) t),
    'players', v_dau
  );
END;
$$;
REVOKE ALL ON FUNCTION hq.cost_report(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.cost_report(integer) TO service_role';
  END IF;
END $$;

INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        tools, autonomy, runtime, status, max_turns, role, tier, model, effort)
VALUES (
  'cost-optimizer', 'agent', 'Cost Optimizer', 'Costs and savings', '💰', 'amber', 'engineering',
  'Goes through what QuizBall pays for (invoices and usage), finds where we spend more than we should, and brings Romero savings with the numbers.',
  $i$Your goal: QuizBall pays only for what it needs. Find where we spend more than we should and bring Romero savings that are safe for players.
Each run:
1) What we pay: hq_cost_report (the ledger of invoices per service and month, and what the database can measure: database and table sizes, file storage per bucket, HQ's own agent runs, daily active players). Per service: this month vs last, the trend, and the cost per daily active player.
2) Why: match each bill to what drives it. Database size (which tables grow, old logs or history we never read, indexes bigger than their tables), file storage (which bucket, what is added each month), analytics events and recordings, server size vs load, egress, AI calls, paid plans or seats nobody uses, duplicate tools. Check providers' current prices and plans with your web tool and cite them.
3) Be 100% sure: a saving counts only when you can show the number it comes from and what it would break (or that it breaks nothing). Label the rest "to check". Never propose something that hurts players (speed, uptime, data they need) without saying so plainly.
4) Ideas: up to 3 a run, biggest saving first, each with the monthly saving (a number and how you got it), the risk, and how to do it (a config change, a cleanup job, a cheaper plan, a code change). Propose them with hq_propose; Romero decides, starts the builds, and asks the founder for anything that changes a plan or a bill.
5) If the ledger is empty or old, say exactly which invoices or billing pages are missing (service and month) so the founder can add them.
6) hq_finish: what we pay (top services), what changed, the savings you proposed (task numbers, money per month), what is missing. No filler.
You never change anything yourself.$i$,
  ARRAY['costs', 'metrics', 'web'], 'autonomous', 'hq', 'paused', 40, 'agent', 'read', 'claude-opus-5-5', 'high'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind, enabled)
SELECT m.id, v.name, v.cron, 'Asia/Tbilisi', v.title, v.body, 'task', true
  FROM hq.members m
  JOIN (VALUES
    ('Weekly cost review', '0 10 * * 1', 'Weekly cost review',
     'What we pay per service, what grew, the biggest savings that are safe for players, and what invoices are missing.'),
    ('Monthly invoice review', '0 11 3 * *', 'Monthly invoice review',
     'Last month''s invoices against the month before: every service, what drove each change, savings for Romero.')
  ) AS v(name, cron, title, body) ON m.slug = 'cost-optimizer'
 WHERE NOT EXISTS (SELECT 1 FROM hq.schedules s WHERE s.member_id = m.id AND s.name = v.name);
