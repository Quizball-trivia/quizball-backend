-- The original Spanish migration ran before goal_choreographies existed on
-- production. A forward migration repairs that guarded skip in both histories.
ALTER TABLE public.goal_choreographies ADD COLUMN IF NOT EXISTS match_label_es text;
