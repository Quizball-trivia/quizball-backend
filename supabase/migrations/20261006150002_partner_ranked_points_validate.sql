SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed (SHARE UPDATE EXCLUSIVE: reads and writes go on).
ALTER TABLE public.partner_ranked_entries VALIDATE CONSTRAINT chk_partner_ranked_entries_points_version;
ALTER TABLE public.partner_ranked_entries VALIDATE CONSTRAINT chk_partner_ranked_entries_score_v2;
