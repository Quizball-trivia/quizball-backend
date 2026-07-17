-- Questions and payloads are backend/CMS-only. Payloads contain correct
-- answers, so Express admin middleware must not be bypassable through the
-- Supabase Data API. The backend and service_role continue to use their
-- privileged database roles; anon/authenticated receive no direct table access.
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_payloads ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.questions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.question_payloads FROM PUBLIC, anon, authenticated;
