-- QuizBall HQ: only the founder's own account authorises work. Other people in
-- the CMS (and Alfred, the founder's GPT, on its own login) can read, chat with
-- the Director and file tasks, but approving, running, sending back, overriding
-- the Director and changing agents, schedules or settings are the founder's.
-- The flag is set per environment by an operator (no personal data in the repo).
ALTER TABLE hq.members ADD COLUMN is_founder boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX hq_members_one_founder ON hq.members (is_founder) WHERE is_founder;
ALTER TABLE hq.members ADD CONSTRAINT hq_members_founder_is_human CHECK (NOT is_founder OR kind = 'human');
