-- Enforce the notification `type` domain at the DB level so out-of-contract
-- values can never be persisted (the API already validates via a Zod enum;
-- this is the matching backstop). Added as a separate migration because the
-- notifications table already shipped without the constraint.
--
-- Idempotent: drop any prior copy of the constraint before adding it.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('points_adjustment', 'season_award', 'announcement', 'friend_request'));
