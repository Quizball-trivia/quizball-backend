# Friend-room invite errors and lifecycle history

Join refusals now distinguish `LOBBY_GAME_STARTED`, `LOBBY_ENDED`, and `LOBBY_NOT_FOUND`.
The acknowledgement, error event and blocked-session event agree. The room descriptor
is bounded to one second and read after locks are released. An unavailable descriptor
stays `unknown`; it never invents an ended game. Classic's closed lobby can still have
an active linked match, which is reported as in progress. Admission and reconnect rules
are unchanged.

`Room lifecycle` is an info-level structured server log, mirrored to the existing log
drain when configured. Filter `event = room_lifecycle` and `version = 1`.

- `created`: room, keyed invite and host signal, game, public/private, age.
- `member_joined`: accepted invite or existing member return.
- `state_observed`: state actually broadcast, or a repository status write; it is an
  observation, not a claim that every repeated broadcast was a state transition.
- `disconnect_reserved`: persisted deadline and grace, recorded before Redis scheduling
  so a scheduling failure still has a trace.
- `reservation_cleared`: actual changed membership, when that member is present again.
- `reservation_expired`: matching due lease actually removed a member.
- `member_left`: actual removal, with explicit leave, session-guard or janitor reason.
- `deleted`: actual deleted row, with reason; no event for a no-op or rolled-back transaction.
- `join_refused`: code, room state, keyed invite, member and attempt signals.

Correlate an invite's `inviteKey` from `created` or `join_refused` with its internal
`lobbyId`, then follow the room and keyed member across events. Deletion history
survives removal of the room row, within the existing log provider's retention.
Signals use domain-separated HMAC with an existing environment secret; raw invite
codes, members, profiles, IPs, socket IDs and credentials are excluded. No new
credential, database table, schema migration, PostHog setting or flag is required.

This is operational logging, not a transactional database audit ledger. Log transport
failure must not break gameplay; a crash between a committed write and its log can
still leave a gap. Pre-deployment room creation cannot be reconstructed retroactively.

Staging verification:

```
npx tsx game-regression/staging/room-errors-lifecycle.mts
npx tsx game-regression/staging/private-room-reservation.mts
```

Both scripts hard-restrict their target to the staging API. Reports contain no raw
invite codes or guest credentials. Check the resulting room IDs against lifecycle
logs, particularly explicit leave, reservation cancellation, and five-minute expiry.
