#!/usr/bin/env npx tsx

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { findBannedNicknameTerm } from '../src/modules/moderation/text-moderation.js';

loadEnv({ path: '.env.local' });
loadEnv();

const databaseUrl = process.env.DATABASE_URL;
const shouldApply = process.argv.includes('--apply');

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

type UserNicknameRow = {
  id: string;
  nickname: string;
};

const sql = postgres(databaseUrl, {
  max: 1,
});

try {
  const users = await sql<UserNicknameRow[]>`
    SELECT id, nickname
    FROM users
    WHERE nickname IS NOT NULL
      AND COALESCE(is_ai, false) = false
      AND is_deleted = false
      AND deleted_at IS NULL
      AND pending_deletion_at IS NULL
  `;

  const flagged = users.flatMap((user) => {
    const match = findBannedNicknameTerm(user.nickname);
    if (!match) return [];
    return [{
      userId: user.id,
      replacementNickname: `Player-${user.id.slice(0, 8)}`,
      reason: match.reason,
      language: match.language,
    }];
  });

  let updatedCount = 0;
  const failures: Array<{ userId: string; replacementNickname: string; error: string }> = [];
  if (shouldApply) {
    for (const user of flagged) {
      try {
        const result = await sql`
          UPDATE users
          SET nickname = ${user.replacementNickname},
              updated_at = NOW()
          WHERE id = ${user.userId}
            AND COALESCE(is_ai, false) = false
        `;
        updatedCount += result.count;
      } catch (error) {
        // A single-row failure (e.g. a unique-index collision on lower(nickname))
        // must not abort the whole batch — record it and keep going.
        failures.push({
          userId: user.userId,
          replacementNickname: user.replacementNickname,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  console.log(JSON.stringify({
    mode: shouldApply ? 'apply' : 'dry-run',
    scannedCount: users.length,
    flaggedCount: flagged.length,
    updatedCount,
    failedCount: failures.length,
    failures,
    flagged,
  }, null, 2));
} finally {
  await sql.end();
}
