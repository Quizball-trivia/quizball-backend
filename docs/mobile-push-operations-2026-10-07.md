# Mobile push operations candidate

The original scoped candidate was merged as backend PR #792 and deployed to staging on October 7, including all seven push tables. Staging registration/preferences HTTP checks pass; delivery and reminder flags remain off. The owner approved an isolated main-based hotfix because staging contains unrelated features. Production sending is not enabled and real provider delivery/taps are still unverified.

The dedicated least-privilege Firebase FCM key is assigned to `io.quizball.mobile` in Expo. Its temporary project-only key-creation exception and elevated role were removed. Company APNs key `SHM4YRA39Q`, team `N9TWV36HUN` (Quizball, LLC), is assigned to `io.quizball.app`; no personal-team key was created. Both private keys remain outside Git. Account-wide Expo token-required push security is enabled with the approved Viewer robot token, configured privately on staging. Its ability to send still requires a real delivery check.

## Deployment order

1. Review the scoped push migration, routes and worker in a PR to staging. For production, use the owner-approved main-based hotfix, then sync its corrections back into staging. Do not promote unrelated staging features.
2. Apply `supabase/migrations/20261007080112_mobile_push_delivery.sql` in staging through the normal migration workflow. All seven push tables enable RLS and revoke direct client access; account-bound access is through the backend.
3. Configure keys securely outside source control:
   - `PUSH_TOKEN_ENCRYPTION_KEY`: random 32-byte hex key for AES-GCM device-token encryption.
   - `PUSH_TOKEN_ENCRYPTION_KEY_ID`: version label, initially `v1`.
   - `PUSH_TOKEN_FINGERPRINT_KEY`: independent stable 32-byte hex HMAC key. Do not silently rotate; the provider-state identity fence detects a mismatch.
   - `PUSH_TOKEN_DECRYPTION_KEYS`: optional JSON version-to-key mapping for a reviewed encryption-key rotation. Retain old keys until records are re-encrypted. Never log this value.
   - `PUSH_EXPO_ACCESS_TOKEN`: required before enabling delivery. Expo's actual console exposes enhanced push security at the Quizball account scope, not project scope. Enable it only with explicit approval and store its authorized token securely. A revocable Viewer robot is the proposed least-privilege identity; verify it can send before considering any broader role. A nonempty token alone does not prove the account protection is enabled; verify that separately. The native FCM/APNs keys themselves belong in Expo credentials, not here.
4. Initially leave `PUSH_DELIVERY_ENABLED=false` and `PUSH_REMINDERS_ENABLED=false`. Registration/preferences can be deployed independently from sending.
5. On staging, enable delivery only with explicit test account UUIDs in `PUSH_TEST_USER_IDS`. The worker and reminder queue reject non-allowlisted staging accounts. An empty list is fail-closed. Do not use production data as fixtures.
6. Verify real signed iOS/Android self-test delivery and notification taps before a separately approved production promotion.

## Contract and ordering

Device register/unregister require an authenticated first-party bearer, platform and positive safe-integer `clientRevision`. Device ownership comes from authentication, never from a client-supplied user ID. Partner accounts are rejected. Test-send is one request per account/minute; register/unregister/preferences writes share a bounded rate limiter. Campaign preview/send require admin authorization and sending is production-only.

A per-token advisory lock and stored revision fence serialize register/unregister ordering. Logout can create an inactive tombstone even before a delayed registration arrives. Older registration or revocation cannot undo a newer state. Unregister under another owner is a no-op. Responses are acknowledgements, not provider delivery proof.

The mobile client journals unacknowledged cleanup without retaining bearer credentials. It retries under the original authenticated owner. Immediate remote revocation while offline/signed out is not guaranteed; OS-background delivery may remain possible until the server receives cleanup or a newer registration supersedes it.

## Sending safeguards

- Preferences default off. Daily reminders start at 19:00 in the chosen valid IANA timezone, configurable for all 24 hours.
- The reminder catch-up window is less than two hours. Already-played daily challenges and a recently sent reminder email suppress duplicate reminder scheduling.
- New-game campaign text must have all four translations and a whitelisted route. No automatic broadcast is triggered by deployment or game creation.
- `PUSH_CAMPAIGN_MAX_DEVICES` defaults to 1,000 and permits 1–10,000. Above-cap audiences roll back entirely. Confirm actual capacity before raising the cap.
- Shared provider backoff bounds request-level authorization errors, rate limiting and transient failures. Individual device failures cannot pause other players. Credential ticket/receipt errors defer that job for 30 minutes until its original expiry, allowing a repaired provider key to recover; they do not drain the queue permanently. Four concurrent tasks handle up to 80 sends and 80 receipt checks per worker tick.
- Ownership, active generation, latest consent, expiry and allowlist are rechecked before sending. Preference opt-out and device revocation cancel queued work.
- Expo tickets are checked for receipts after approximately 15 minutes; checks stop within 23 hours of ticketing. An accepted receipt does not prove the player saw a notification.
- Ambiguous network/process failures can duplicate delivery: this is bounded at-least-once dispatch, not exactly-once delivery. Tap event IDs are deduplicated client-side.
- Jobs/events expire; event retention is 30 days and stale devices are removed after 90 days. Disabling delivery stops the worker but does not itself delete account preferences.

## Verification boundaries

The isolated local suite passes 51 tests across repository, worker, transport and database-target files using only PostgreSQL `quizball_push_test_20261007` on loopback. Thirteen OpenAPI snapshot/contract tests pass. The fixture explicitly covers the production users table without staging's optional `partner_slug` column, plus filtering when that optional column exists. The default shared-database suite excludes this tier; CI runs `npm run test:push` separately on its disposable PostgreSQL service. The dedicated URL guard rejects remote hosts, other database names and connection-override query parameters before connecting. These tests do not contact Expo, Firebase, Apple, staging or production. They cover malformed provider replies, timeouts, shared request-level backoff, bounded credential retries and isolation of individual device failures. Both device routes require a revision, and registration acknowledgement permits both true and false.

Separate deployed staging HTTP verification confirms health, unauthenticated rejection, the review account's mapped internal identity, authenticated preferences/daily list, registration body validation, and rejection of regular-user campaign access. It did not register a device or send a campaign. Real provider delivery, signed-device taps, production scheduling, key rotation and operational throughput still need live verification.

To stop sending, set `PUSH_DELIVERY_ENABLED=false`. To stop only reminder scheduling/delivery, set `PUSH_REMINDERS_ENABLED=false`. Existing campaigns are not created by these switches. Rollback must preserve the migration's ordering/tombstone state until delayed requests and jobs have been resolved.
