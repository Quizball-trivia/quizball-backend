-- QuizBall HQ: a Security Engineer and a Performance Engineer. Both only read: the code (read-only copies of the
-- three repos on the HQ server), the production database's own reports below, and timings of public endpoints.
-- They report verified findings to the Executive Director, who turns real problems into verified builds.

-- ── 1. read-only database reports (SECURITY DEFINER: they read catalog and statistics views) ─────────────────
CREATE FUNCTION hq.perf_db_report(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 5), 50);
  v_statements jsonb := '[]'::jsonb;
BEGIN
  IF to_regclass('extensions.pg_stat_statements') IS NOT NULL THEN
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(s ORDER BY s.total_ms DESC), '[]'::jsonb) FROM (
        SELECT left(regexp_replace(regexp_replace(regexp_replace(query, '''[^'']*''', '''?''', 'g'), '\m\d{4,}\M', '?', 'g'), '\s+', ' ', 'g'), 600) AS query, calls,
               round(total_exec_time)::bigint AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
               round(max_exec_time::numeric, 1) AS max_ms, rows,
               round(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
          FROM extensions.pg_stat_statements
         WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND query NOT ILIKE '%%pg_stat_statements%%'
         ORDER BY total_exec_time DESC LIMIT %s) s$q$, v_limit)
    INTO v_statements;
  END IF;
  RETURN jsonb_build_object(
    'generated_at', now(),
    'note', 'Statement statistics accumulate since the last reset; query text is normalised ($1 for values).',
    'top_statements_by_total_time', v_statements,
    'tables_most_seq_scanned', (
      SELECT COALESCE(jsonb_agg(t ORDER BY t.seq_tup_read DESC), '[]'::jsonb) FROM (
        SELECT schemaname || '.' || relname AS "table", seq_scan, seq_tup_read, idx_scan, n_live_tup,
               pg_size_pretty(pg_total_relation_size(relid)) AS size
          FROM pg_stat_user_tables WHERE n_live_tup > 10000
         ORDER BY seq_tup_read DESC LIMIT v_limit) t),
    'largest_tables', (
      SELECT COALESCE(jsonb_agg(t ORDER BY t.bytes DESC), '[]'::jsonb) FROM (
        SELECT schemaname || '.' || relname AS "table", pg_total_relation_size(relid) AS bytes,
               pg_size_pretty(pg_total_relation_size(relid)) AS size, n_live_tup, n_dead_tup, last_autovacuum
          FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT v_limit) t),
    'unused_indexes', (
      SELECT COALESCE(jsonb_agg(i ORDER BY i.bytes DESC), '[]'::jsonb) FROM (
        SELECT s.schemaname || '.' || s.indexrelname AS index, s.schemaname || '.' || s.relname AS "table",
               pg_relation_size(s.indexrelid) AS bytes, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
          FROM pg_stat_user_indexes s JOIN pg_index x ON x.indexrelid = s.indexrelid
         WHERE s.idx_scan = 0 AND NOT x.indisunique AND NOT x.indisprimary AND pg_relation_size(s.indexrelid) > 1048576
         ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT v_limit) i),
    'cache_hit_pct', (
      SELECT round(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2) FROM pg_stat_database WHERE datname = current_database()),
    'connections', (
      SELECT COALESCE(jsonb_object_agg(COALESCE(state, 'unknown'), n), '{}'::jsonb) FROM (
        SELECT state, count(*) AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY state) c)
  );
END;
$$;

CREATE FUNCTION hq.security_db_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_buckets jsonb := '[]'::jsonb;
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(jsonb_agg(name ORDER BY name), ''[]''::jsonb) FROM storage.buckets WHERE public' INTO v_buckets;
  END IF;
  RETURN jsonb_build_object(
    'generated_at', now(),
    'note', 'Tables reachable through the public API (schema public) without row-level security can be read or written by anyone holding the anon key if they are also granted to anon/authenticated.',
    'public_tables_without_rls', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'table', c.relname,
               'anon_privileges', (SELECT string_agg(DISTINCT privilege_type, ',') FROM information_schema.role_table_grants g
                                    WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee = 'anon'),
               'authenticated_privileges', (SELECT string_agg(DISTINCT privilege_type, ',') FROM information_schema.role_table_grants g
                                    WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee = 'authenticated'))
             ORDER BY c.relname), '[]'::jsonb)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity),
    'rls_tables_without_policies', (
      SELECT COALESCE(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)),
    'permissive_policies_for_api_roles', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'command', cmd, 'roles', roles,
                                                   'using_is_true', qual = 'true', 'check_is_true', with_check = 'true') ORDER BY tablename), '[]'::jsonb)
        FROM pg_policies
       WHERE schemaname = 'public' AND (roles && ARRAY['anon', 'authenticated', 'public']::name[])
         AND (qual = 'true' OR with_check = 'true')),
    'security_definer_functions_without_search_path', (
      SELECT COALESCE(jsonb_agg(n.nspname || '.' || p.proname ORDER BY n.nspname, p.proname), '[]'::jsonb)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname IN ('public', 'hq')
         AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')),
    'security_definer_functions_callable_by_api_roles', (
      SELECT COALESCE(jsonb_agg(n.nspname || '.' || p.proname ORDER BY n.nspname, p.proname), '[]'::jsonb)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname = 'public'
         AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    'public_storage_buckets', v_buckets
  );
END;
$$;

REVOKE ALL ON FUNCTION hq.perf_db_report(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.security_db_report() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.perf_db_report(integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.security_db_report() TO service_role';
  END IF;
END $$;

-- ── 2. the two engineers (paused until the worker with their tools is live) ──────────────────────────────────
INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        tools, autonomy, runtime, status, max_turns, role, tier, model, effort)
VALUES
(
  'security-engineer', 'agent', 'Security Engineer', 'Application security', '🛡️', 'slate', 'engineering',
  'Reads the code and the database''s security settings and reports real, verified security problems.',
  $i$Find real security problems in QuizBall (backend, web, CMS; Supabase Postgres). Each run:
1) hq_security_db_report: tables in the public API without row-level security and what anon/authenticated may do with them, permissive policies, SECURITY DEFINER functions without a fixed search_path or callable by the API roles, public storage buckets.
2) hq_dependency_audit for each repo: known vulnerable packages (production dependencies first).
3) Read the code behind anything suspicious (hq_code_search, hq_code_read): auth and role checks on routes, admin endpoints, input validation, secrets in code, SQL built from strings, CORS, rate limits, socket handlers that trust client data, file uploads.
VERIFY before you report: show the exact file:line or the database object, and explain the concrete way it could be abused and what it would expose. A finding you could not confirm is "to check", never "critical". No duplicates: check hq_list_tasks first.
Report each confirmed finding with hq_propose (one per finding): severity, evidence, impact and the fix. The Director decides and can start a build to fix it. Never paste secrets, keys or personal data into a task. If you find nothing new, say so in one line.$i$,
  ARRAY['code', 'security', 'web'], 'autonomous', 'hq', 'paused', 40, 'agent', 'read', 'claude-opus-5-5', 'high'
),
(
  'performance-engineer', 'agent', 'Performance Engineer', 'Performance and cost', '⚡', 'amber', 'engineering',
  'Finds what makes QuizBall slow or expensive (database, endpoints, code) and proposes measured fixes.',
  $i$Find what makes QuizBall slow or costly. Each run:
1) hq_perf_db_report: the statements using the most database time (calls, mean and max ms, cache hit), tables scanned sequentially, the largest tables, unused indexes, connections.
2) hq_http_timing on the main public endpoints (the API health and leaderboard, the home page): note slow or failing ones.
3) For the top problems, read the code that sends the query or serves the endpoint (hq_code_search, hq_code_read) and find the cause: a missing index, N+1 queries, an unbounded query, a query in a hot loop, work that could be cached.
VERIFY with numbers before you report: the statement and its share of total time, the endpoint timing, the code path (file:line). Propose the smallest fix with the expected gain. No duplicates: check hq_list_tasks first. Report each as hq_propose (one idea per problem) so the Director can start a build. If nothing changed since your last report, say so in one line.$i$,
  ARRAY['code', 'perf', 'metrics'], 'autonomous', 'hq', 'paused', 40, 'agent', 'read', 'claude-sonnet-5-5', NULL
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind, enabled)
SELECT m.id, v.name, v.cron, 'Asia/Tbilisi', v.title, v.body, 'task', true
  FROM hq.members m
  JOIN (VALUES
    ('security-engineer', 'Weekly security review', '0 4 * * 1', 'Weekly security review', 'Review the database security report, dependencies and the code behind anything suspicious; report verified findings.'),
    ('performance-engineer', 'Daily performance check', '30 5 * * *', 'Daily performance check', 'Check the database and endpoint performance; report the biggest measured problems with fixes.')
  ) AS v(slug, name, cron, title, body) ON v.slug = m.slug
 WHERE NOT EXISTS (SELECT 1 FROM hq.schedules s WHERE s.member_id = m.id AND s.name = v.name);

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind)
SELECT m.id, 'Daily standup', '0 8 * * *', 'Asia/Tbilisi', 'Daily standup',
       'Morning standup: report yesterday / today / blockers and propose up to 3 ideas that move the goals.', 'standup'
  FROM hq.members m
 WHERE m.slug IN ('security-engineer', 'performance-engineer')
ON CONFLICT (member_id) WHERE task_kind = 'standup' DO NOTHING;
