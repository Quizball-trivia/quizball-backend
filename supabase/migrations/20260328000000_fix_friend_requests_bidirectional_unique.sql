-- Drop the old unordered unique index
DROP INDEX IF EXISTS public.friend_requests_pending_unique_pair;

-- Create a new unique index with LEAST/GREATEST for bidirectional uniqueness
-- This prevents both A->B and B->A pending requests at the same time
CREATE UNIQUE INDEX friend_requests_pending_unique_pair
  ON public.friend_requests (
    LEAST(sender_user_id, receiver_user_id),
    GREATEST(sender_user_id, receiver_user_id)
  )
  WHERE status = 'pending';
