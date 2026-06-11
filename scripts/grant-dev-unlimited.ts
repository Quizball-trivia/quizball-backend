#!/usr/bin/env npx tsx

/**
 * One-time grant: top up the dev-team accounts to a huge coin/ticket balance so
 * they can exercise every paid flow on staging without grinding. Pairs with the
 * DEV_UNLIMITED_EMAILS allowlist that bypasses the store economy limits.
 *
 * Targets are read from DEV_UNLIMITED_EMAILS (comma-separated) so the script and
 * the runtime bypass always cover the same accounts. Matched case-insensitively.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   npx tsx scripts/grant-dev-unlimited.ts            # preview
 *   npx tsx scripts/grant-dev-unlimited.ts --apply    # execute
 */

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });
loadEnv();

const DEV_COINS = 1_000_000;
const DEV_TICKETS = 100_000;

const databaseUrl = process.env.DATABASE_URL;
const shouldApply = process.argv.includes('--apply');

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const emails = (process.env.DEV_UNLIMITED_EMAILS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

if (emails.length === 0) {
  console.error('DEV_UNLIMITED_EMAILS is empty — nothing to grant. Set it first.');
  process.exit(1);
}

type UserRow = {
  id: string;
  email: string | null;
  coins: number;
  tickets: number;
};

const sql = postgres(databaseUrl, { max: 1 });

try {
  const users = await sql<UserRow[]>`
    SELECT id, email, coins, tickets
    FROM users
    WHERE LOWER(email) = ANY(${emails})
  `;

  const foundEmails = new Set(users.map((u) => (u.email ?? '').toLowerCase()));
  const missing = emails.filter((email) => !foundEmails.has(email));

  console.log(`Target dev emails (${emails.length}): ${emails.join(', ')}`);
  console.log(`Matched accounts: ${users.length}`);
  for (const user of users) {
    console.log(
      `  ${user.email} (${user.id}): coins ${user.coins} -> ${DEV_COINS}, tickets ${user.tickets} -> ${DEV_TICKETS}`
    );
  }
  if (missing.length > 0) {
    console.warn(`  NOT FOUND (no account in this DB): ${missing.join(', ')}`);
  }

  if (!shouldApply) {
    console.log('\nDry run — no changes written. Re-run with --apply to execute.');
    process.exit(0);
  }

  if (users.length === 0) {
    console.log('\nNo matching accounts to update.');
    process.exit(0);
  }

  const targetIds = users.map((u) => u.id);
  const updated = await sql<UserRow[]>`
    UPDATE users
    SET coins = ${DEV_COINS},
        tickets = ${DEV_TICKETS},
        tickets_refill_started_at = NULL,
        updated_at = NOW()
    WHERE id = ANY(${targetIds})
    RETURNING id, email, coins, tickets
  `;

  console.log(`\nApplied. Updated ${updated.length} account(s):`);
  for (const user of updated) {
    console.log(`  ${user.email}: coins=${user.coins}, tickets=${user.tickets}`);
  }
} catch (error) {
  console.error('Grant failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
