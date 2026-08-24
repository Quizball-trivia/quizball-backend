# Retention experiments: rollout and email plan

## Product experiments prepared in this branch

All three product experiments fail closed. If PostHog is unavailable, the current UI remains visible. Their flags are draft/inactive until a deliberate launch.

### Daily completion comeback

- Flag: `daily-completion-comeback`
- Control: current completion modal.
- Test: current modal plus the Daily streak, the next consecutive-day reward, and a real "Remind me tomorrow" action.
- The backend calculates the streak and owns reward delivery. A unique `(user_id, challenge_day)` ledger row prevents a player from receiving the bonus twice.
- Reward and reminder delivery have separate server switches, both off by default.
- This experiment must not enroll while `daily-completion-weekend-league-cta` still assigns a variant on the same modal.
- Primary outcome: another Daily Challenge completion on the next calendar day.
- Secondary outcomes: reminder scheduled and seven-day Daily retention.
- Guardrails: duplicate reward attempts, email failures, unsubscribes, and total coins issued.

### Ranked loss recovery

- Flag: `ranked-results-loss-recovery`
- Control: current results screen.
- Test: a minimal cue showing the exact RP lost and a recovery message.
- Only settled Ranked losses with a positive authoritative RP decrease are eligible. Friendly, placement, draw, cancelled, and no-RP-loss results are excluded.
- Primary outcome: another Ranked match starts after the results exposure.
- Secondary outcome: Play Again click.
- Guardrails: main-menu exits and Play Again attempts when the player cannot enter a match.

### Weekend League progress rail

- Flag: `home-weekend-league-progress`
- Control: exact current navy-to-blue Weekend League rail.
- Test: the same rail with live QP progress, qualifying state, and server-based countdown. The whole rail remains the existing Weekend League link; no extra button is added.
- Only Georgian players with a live tournament are eligible.
- Primary outcome: Weekend League opened.
- Secondary outcome: Weekend League entry completed.
- Guardrail: Ranked starts must not fall.

## Safe activation order

1. Apply the database migration in staging.
2. Deploy the backend to staging with both Daily switches still off.
3. Deploy the web branch to staging and test control/test overrides, Georgian and non-Georgian accounts, all Weekend League states, and Ranked exclusions.
4. Enable Daily rewards in staging, complete Daily challenges concurrently, and confirm exactly one bonus per player/day.
5. Enable Daily reminder delivery in staging, schedule/cancel a reminder, confirm one email, and confirm unsubscribe prevents another send.
6. Verify the new diagnostic event names arrive in staging PostHog.
7. Add verified PostHog metrics to the three draft experiments.
8. Promote database, backend, and web in that order. Keep the new flags inactive and server switches off during promotion.
9. End or pause the existing Daily-to-Weekend-League modal experiment before launching the Daily comeback experiment.
10. Launch only one new experiment at a time initially, then monitor allocation, errors, and guardrails for 24 hours before starting another.

## First inactive-player email experiment

Implementation status: built behind `RETENTION_EMAIL_EXPERIMENT_ENABLED=false` and the inactive PostHog flag `email-comeback-weekend-league` (experiment 443340). Database assignment is authoritative; email addresses are never included in PostHog properties.

Rollout safety: `RETENTION_EMAIL_ASSIGNMENT_CAP=0` is a second hard stop. Staging can also set `RETENTION_EMAIL_USER_ID_ALLOWLIST` to approved backend user UUIDs. Production should raise the durable assignment cap in explicit stages (for example 20, 100, then the planned sample); the database advisory lock prevents multiple worker replicas from exceeding it.

Delivery status is closed through the signed Resend webhook at `POST /api/v1/email/resend/webhook`. Launch requires `RESEND_WEBHOOK_SECRET`; provider event IDs are stored for replay safety, while full payloads and recipient addresses are not stored in the webhook ledger.

### Hypothesis

A single, timely Weekend League email to eligible players inactive for 3–7 days increases returned sessions and match starts within 24 hours without causing unacceptable unsubscribe or delivery-failure rates.

### Eligibility

- Real players inactive for 3–7 complete days at the assignment timestamp.
- A valid email that may receive this type of message under the current consent policy.
- Not unsubscribed, bounced/suppressed, banned, deleted, AI, or seed data.
- Georgian player, because Weekend League is currently Georgia-only.
- A live Weekend League entry window exists.
- Player has not entered the tournament yet.
- No other retention email was assigned in the previous seven days.

### Assignment

- Assign 50/50 once on the backend and persist the assignment before attempting delivery.
- Control: no email.
- Test: exactly one email.
- The assignment timestamp is time zero for both variants. This is essential: measuring only sent or clicked emails would omit the control group and bias the result.
- Persist campaign, player, tournament, eligibility state, variant, assignment time, send status, provider message ID, click time, and unsubscribe state. Do not send email addresses or other personal data to PostHog.

### Timing and content

- Run across at least two Weekend League entry windows, and continue until the precomputed sample target is reached.
- Send the test email 18–24 hours before the live tournament's `entry_closes_at`, using server time.
- If the player still needs QP, show the exact live QP remaining and link to Ranked.
- If the player has enough QP, ask them to enter Weekend League and link to the tournament page.
- Do not promise coins, tickets, or prizes unless the live backend state guarantees them.
- Do not include players whose live state changed to entered, ineligible, unsubscribed, or recently emailed between assignment and send.

### Tracking contract

Backend events, using an anonymous player identifier only:

- `retention_email_assigned`: both variants; campaign, variant, tournament, and eligibility state.
- `retention_email_sent`: test only; accepted by provider.
- `retention_email_delivery_failed`: test only; failure class and retry count.
- `retention_email_clicked`: test only; recorded by a signed redirect endpoint before redirecting to the app.
- `retention_email_unsubscribed`: campaign and message attribution where available.

Decision metrics are intention-to-treat from `retention_email_assigned`:

- Primary: `match_started` within 24 hours.
- Secondary: returned app session within 24 hours; Weekend League opened; Weekend League entry completed.
- Diagnostics: sent, delivered, first opened/open count when webhook data is available, clicked, CTA state, and destination.
- Guardrails: unsubscribe rate, permanent delivery-failure rate, complaints if available, and the one-retention-email-per-seven-days rule.

Email opens are diagnostic only. Privacy protections and mail-client image caching make opens unsuitable as the decision metric.

### Attribution links

Use signed redirect links with non-personal identifiers and these campaign parameters:

`utm_source=retention_email&utm_medium=email&utm_campaign=weekend_league_comeback_v1`

The redirect endpoint records one idempotent click, validates the destination against an allowlist, and then redirects to either Weekend League or Ranked. Raw email addresses must never appear in URLs or analytics properties.

## Established dormant-player comeback experiment

This is a separate experiment from the deadline-based Weekend League email.
It targets contactable Georgian players whose last non-dev match was 14–90
days ago and who have played at least three lifetime matches. The initial
production cap is 200 assignments: a 50/50 PostHog split produces roughly 100
emails and 100 no-email controls.

- Flag: `email-comeback-dormant-players`.
- Campaign: `dormant_player_comeback_v1`.
- Control: persist the assignment and send nothing.
- Test: send one Georgian/English comeback email linking to `/play`.
- Primary: `match_started` within 72 hours of assignment.
- Secondary: returned session within 72 hours and three matches within seven days.
- Guardrails: delivery failures, complaints, unsubscribes, and no more than one
  retention assignment per player in seven days across all campaigns.

The message does not mention Weekend League, coins, cosmetics, or another
reward. A reward must not be introduced until an idempotent backend grant exists.
The experiment uses its own server switch and assignment cap; changing the
Weekend League cap cannot broaden this cohort.

### Launch gate

Before creating or activating the email experiment, calculate the current eligible cohort size and the required sample size. Do not launch if consent eligibility, provider webhooks, unsubscribe handling, global frequency limiting, or control-group assignment cannot be verified end to end in staging.

## Next experiment: first-day three-match mission

Build this only after the comeback email test is staged and its tracking is verified.

- Audience: genuinely new players on their first Georgia calendar day, after completing their first eligible match.
- Control: current Play home and results experience.
- Test: a persistent “Complete 3 matches today” mission shown after match one, updated after match two, and completed after match three.
- Reward: one backend-selected, non-tradable starter cosmetic from an approved store pool. Do not promise a random paid item or anything the backend cannot guarantee.
- Progress: server-owned and derived from completed, non-dev matches. A unique mission-claim ledger must make the reward idempotent.
- Farming protection: abandoned, cancelled, dev, and trivially forfeited matches do not count. Decide the minimum participation rule before launch.
- Primary: third eligible match completed on day one.
- Funnel: first match completed → second match started → second completed → third started → third completed → reward claimed/equipped.
- Retention: next-day session and D7 match start.
- Guardrails: abandonment, suspicious match farming, reward duplication, support complaints, and paid-store conversion.

The initial experiment should test the complete mission package rather than changing reward values between variants. Once the package proves it increases three-match completion, reward type or presentation can be optimized separately.
