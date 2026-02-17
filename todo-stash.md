# RLS (Row-Level Security) — TODO

RLS is currently **disabled** on all public tables. Before going to production, enable RLS and add policies for each table. This needs careful planning since the backend uses a service-role connection (bypasses RLS) but we still want defense-in-depth.

### Tables that need policies
- `lobbies` — owner: `host_user_id`
- `lobby_categories` — via `lobby_id`
- `lobby_category_bans` — via `lobby_id`
- `lobby_members` — `user_id` + `lobby_id`
- `matches` — players via `match_players`
- `match_players` — `user_id` + `match_id`
- `match_questions` — via `match_id`
- `match_answers` — `user_id` + `match_id`
- `categories`, `questions`, `question_payloads` — read-only for authenticated
- `users`, `user_identities` — own-row only for authenticated

### Considerations
- Backend connects as **service role** (bypasses RLS) — so RLS primarily guards against direct Supabase client access
- Decide if frontend will ever query Supabase directly (currently it doesn't — all through backend API)
- If backend-only access, RLS is defense-in-depth; policies can be simple (deny anon, allow service role)
- If frontend direct access is planned, policies need precise USING/WITH CHECK clauses per table
