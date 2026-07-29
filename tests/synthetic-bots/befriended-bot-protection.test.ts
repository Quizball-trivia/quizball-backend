/**
 * PR12 behaviour 1 — friend requests to persistent bots.
 *
 * The friend-response worker (be#319) and the cleanup allowlist (PR1) ALREADY
 * cover persistent bots; PR12 verifies the interplay rather than changing it,
 * because the two predicates were written for different populations and their
 * combination is what the plan actually depends on:
 *
 *   - the responder selects on `receiver.is_ai = true`, and the strict CHECK
 *     `is_ai = (ai_kind IS NOT NULL)` means every persistent bot satisfies it —
 *     so roster bots answer friend requests with the same 30/70 mix as
 *     ephemeral ones, with no persistent-specific branch to drift;
 *   - cleanup_ai_users() selects on `ai_kind IN ('ephemeral','auction')`, so a
 *     persistent bot is undeletable regardless of friendship;
 *   - selection eligibility never reads friendship, so befriending a bot cannot
 *     remove it from the match pool.
 *
 * Net invariant, asserted here: a befriended persistent bot stays SELECTABLE
 * and stays UNDELETABLE. These are SQL-level facts, so the predicates are
 * asserted against the migration text — the source of truth that ships.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import '../setup.js';

const MIGRATIONS = join(__dirname, '../../supabase/migrations');

function migration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

describe('befriended persistent bot — cleanup protection', () => {
  const cleanupSql = migration('20260727150000_ai_kind_classification.sql');

  it('restricts cleanup victims to ephemeral and auction bots', () => {
    // The allowlist is POSITIVE: a future ai_kind is protected by default
    // rather than silently becoming deletable.
    expect(cleanupSql).toContain("u.ai_kind IN ('ephemeral', 'auction')");
    expect(cleanupSql).not.toMatch(/ai_kind\s*(<>|!=)\s*'persistent'/);
  });

  it('keeps the friendship and pending-request protections for the drainable kinds', () => {
    // Ephemeral bots that entered the social graph must still survive; PR12
    // must not have weakened be#319's protection while touching this area.
    expect(cleanupSql).toContain('FROM public.friendships f');
    expect(cleanupSql).toContain("fr.status = 'pending'");
  });
});

describe('friend responder predicate covers persistent bots', () => {
  it('selects every AI receiver by is_ai, with no ai_kind narrowing', () => {
    const repo = readFileSync(
      join(__dirname, '../../src/modules/friends/friends.repo.ts'),
      'utf8'
    );
    const query = repo.slice(repo.indexOf('listPendingAiFriendRequests'));
    expect(query).toContain('receiver.is_ai = true');
    // A persistent-excluding predicate here would silently strand roster bots
    // with permanently unanswered friend requests.
    expect(query.slice(0, query.indexOf('LIMIT'))).not.toContain("ai_kind = 'ephemeral'");
  });
});

describe('zero-accepts invariant is enforced in SQL, not only in the service', () => {
  const repo = readFileSync(
    join(__dirname, '../../src/modules/lobbies/lobby-challenge-invitations.repo.ts'),
    'utf8'
  );
  const updateStatus = repo.slice(repo.indexOf('async updateStatus'));

  it('refuses to write accepted when the invite target is a bot', () => {
    // Defence in depth: acceptChallenge checks this too, but that is ONE
    // caller. Putting the predicate on the only write that can produce
    // 'accepted' means a future path cannot bypass it by forgetting to look.
    expect(updateStatus).toContain("<> 'accepted'");
    expect(updateStatus).toContain('u.is_ai = true');
  });

  it('leaves the non-accept statuses available for bots', () => {
    // The decline worker depends on being able to write 'declined' for a bot
    // target; the guard must be scoped to 'accepted' alone.
    expect(updateStatus).toMatch(/\$\{status\}::text <> 'accepted'\s*\n\s*OR NOT EXISTS/);
  });
});

describe('rename candidate query — multi-replica safety', () => {
  const repo = readFileSync(
    join(__dirname, '../../src/modules/synthetic-bots/synthetic-bots.repo.ts'),
    'utf8'
  );
  const listRenameCandidates = repo.slice(
    repo.indexOf('async listRenameCandidates'),
    repo.indexOf('async bumpMatchesTodayAndSelectedAt')
  );

  it('excludes bots that renamed recently', () => {
    // The per-tick draw is hash-deterministic, so on a firing hour EVERY
    // replica draws true for the same bot. Without this exclusion each would
    // write its own nickname_history row while free allowance remains.
    expect(listRenameCandidates).toContain('FROM nickname_history nh');
    expect(listRenameCandidates).toContain("nh.changed_at > NOW() - INTERVAL '30 days'");
  });

  it('excludes bots that are currently reserved for a match', () => {
    // A name must never change under a live opponent.
    expect(listRenameCandidates).toContain('FROM synthetic_bot_reservations r');
  });

  it('only ever considers active persistent bots with a propensity', () => {
    expect(listRenameCandidates).toContain("u.ai_kind = 'persistent'");
    expect(listRenameCandidates).toContain("p.status = 'active'");
    expect(listRenameCandidates).toContain('p.rename_propensity > 0');
  });
});

describe('selection eligibility ignores friendship', () => {
  it('never joins friendships when listing eligible bots', () => {
    const repo = readFileSync(
      join(__dirname, '../../src/modules/synthetic-bots/synthetic-bots.repo.ts'),
      'utf8'
    );
    const listEligible = repo.slice(
      repo.indexOf('async listEligibleBots'),
      repo.indexOf('async listRenameCandidates')
    );
    // Befriending a bot must not shrink the match pool.
    expect(listEligible).not.toContain('friendships');
    expect(listEligible).not.toContain('friend_requests');
  });
});
