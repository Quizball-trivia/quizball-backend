-- Index on lobby_members.user_id to speed up queries that look up a user's lobbies
-- (e.g., checking if user is already in a lobby, listing user's active lobbies)

CREATE INDEX lobby_members_user_id_idx ON public.lobby_members (user_id);
