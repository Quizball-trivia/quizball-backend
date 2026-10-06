/** Freecroco staff accounts, managed by Quizball admins in the CMS (internal API §2). A staff member is a users row
 *  with role 'partner_staff' plus a partner_operator_memberships row; a Quizball admin is never made staff and never
 *  has their role changed here. Every change is audited. */

import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { invalidateByUserId } from '../users/user-cache.js';
import { asSql, type Db } from './partner-db.js';
import type { PartnerConfig } from './partner-config.js';
import { PartnerError } from './partner-errors.js';
import { getStaffInviter } from './partner-staff-invites.js';

export type StaffRole = 'viewer' | 'editor';
const staffRoleSchema = z.enum(['viewer', 'editor']);

export const staffAddBodySchema = z
  .object({ email: z.string().trim().toLowerCase().max(254).email(), role: staffRoleSchema })
  .strict();
export type StaffAddBody = z.infer<typeof staffAddBodySchema>;

export const staffPatchBodySchema = z.object({ role: staffRoleSchema }).strict();
export const staffParamSchema = z.object({ userId: z.string().uuid() });

export interface PartnerStaffMember {
  userId: string;
  email: string | null;
  role: StaffRole;
  addedAt: string;
  addedBy: { userId: string; email: string | null } | null;
  /** From Supabase Auth when this database can read it; null otherwise or before the first sign-in. */
  lastSignInAt: string | null;
}

export interface StaffAddResult {
  member: PartnerStaffMember;
  /** existing: a Quizball account was converted; invited: a new account was invited (or, stub mode, pretended). */
  account: 'existing' | 'invited';
  /** False when the email already had a Supabase sign-in, so no invite email went out. */
  inviteSent: boolean;
}

interface MemberRow {
  user_id: string;
  email: string | null;
  role: StaffRole;
  created_at: Date;
  created_by: string | null;
  created_by_email: string | null;
}

async function memberRows(db: Db, config: PartnerConfig, userId?: string): Promise<MemberRow[]> {
  return db<MemberRow[]>`
    SELECT m.user_id, u.email, m.role, m.created_at, m.created_by, cb.email AS created_by_email
    FROM partner_operator_memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users cb ON cb.id = m.created_by
    WHERE m.partner_slug = ${config.slug} ${userId ? db`AND m.user_id = ${userId}` : db``}
    ORDER BY m.created_at, m.user_id`;
}

let authUsersReadable: boolean | null = null;

/** Supabase's last sign-in per staff user. Not every database has (or grants) auth.users: then there is none. */
async function lastSignIns(userIds: string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0 || authUsersReadable === false) return new Map();
  try {
    const [{ present }] = await sql<{ present: boolean }[]>`SELECT to_regclass('auth.users') IS NOT NULL AS present`;
    if (!present) {
      authUsersReadable = false;
      return new Map();
    }
    const rows = await sql<{ user_id: string; at: Date | null }[]>`
      SELECT i.user_id, max(a.last_sign_in_at) AS at
      FROM user_identities i
      JOIN auth.users a
        ON a.id = CASE WHEN i.subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN i.subject::uuid END
      WHERE i.provider = 'supabase' AND i.user_id = ANY(${userIds}::uuid[])
      GROUP BY i.user_id`;
    authUsersReadable = true;
    return new Map(rows.filter((r) => r.at).map((r) => [r.user_id, r.at as Date]));
  } catch (err) {
    if ((err as { code?: string }).code === '42501') authUsersReadable = false;
    logger.warn({ err }, 'Partner staff: last sign-in unavailable');
    return new Map();
  }
}

function toMember(row: MemberRow, lastSignIn: Date | undefined): PartnerStaffMember {
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    addedAt: row.created_at.toISOString(),
    addedBy: row.created_by ? { userId: row.created_by, email: row.created_by_email } : null,
    lastSignInAt: lastSignIn?.toISOString() ?? null,
  };
}

async function withSignIns(rows: MemberRow[]): Promise<PartnerStaffMember[]> {
  const signIns = await lastSignIns(rows.map((r) => r.user_id));
  return rows.map((r) => toMember(r, signIns.get(r.user_id)));
}

export async function listStaff(config: PartnerConfig): Promise<{ items: PartnerStaffMember[] }> {
  return { items: await withSignIns(await memberRows(sql, config)) };
}

async function audit(
  tx: Db,
  config: PartnerConfig,
  actorUserId: string,
  action: string,
  userId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`
    INSERT INTO partner_audit (partner_slug, environment, actor, action, target, before, after)
    VALUES (${config.slug}, ${config.environment}, ${`user:${actorUserId}`}, ${action}, ${`user:${userId}`},
            ${before === null ? null : tx.json(before as never)}, ${after === null ? null : tx.json(after as never)})`;
}

interface CandidateRow {
  id: string;
  email: string | null;
  role: string;
  partner_slug: string | null;
  is_guest: boolean;
  is_ai: boolean;
  is_banned: boolean;
  is_deleted: boolean;
  deleted_at: Date | null;
  pending_deletion_at: Date | null;
}

function ineligibility(user: CandidateRow): string | null {
  if (user.role === 'admin') return 'This is a Quizball admin account; admins already see the Freecroco section';
  if (user.partner_slug !== null) return 'This is a partner player account';
  if (user.is_ai || user.is_guest) return 'This is not a registered account';
  if (user.is_deleted || user.deleted_at) return 'This account was deleted';
  if (user.pending_deletion_at) return 'This account is being deleted';
  if (user.is_banned) return 'This account is banned';
  if (user.role !== 'user' && user.role !== 'partner_staff') return 'This account cannot be made partner staff';
  return null;
}

/** Makes one locked, eligible account a member. Runs inside the add transaction. */
async function enroll(
  tx: Db,
  config: PartnerConfig,
  actorUserId: string,
  userId: string,
  role: StaffRole,
  account: StaffAddResult['account'],
): Promise<void> {
  const [user] = await tx<CandidateRow[]>`
    SELECT id, email, role, partner_slug, is_guest, is_ai, is_banned, is_deleted, deleted_at, pending_deletion_at
    FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!user) throw new PartnerError('not_found');
  const problem = ineligibility(user);
  if (problem) throw new PartnerError('staff_not_eligible', problem);
  const [existing] = await tx`
    SELECT 1 FROM partner_operator_memberships WHERE partner_slug = ${config.slug} AND user_id = ${userId}`;
  if (existing) throw new PartnerError('staff_exists');
  if (user.role !== 'partner_staff') {
    await tx`UPDATE users SET role = 'partner_staff', updated_at = now() WHERE id = ${userId}`;
  }
  await tx`
    INSERT INTO partner_operator_memberships (partner_slug, user_id, role, created_by)
    VALUES (${config.slug}, ${userId}, ${role}, ${actorUserId})`;
  await audit(tx, config, actorUserId, 'staff.add', userId, null, {
    email: user.email,
    role,
    account,
    previousUserRole: user.role,
  });
}

export async function addStaff(config: PartnerConfig, actorUserId: string, body: StaffAddBody): Promise<StaffAddResult> {
  const { email, role } = body;
  const matches = await sql<{ id: string }[]>`
    SELECT id FROM users
    WHERE lower(email) = ${email} AND is_deleted = false AND deleted_at IS NULL AND is_ai = false
    LIMIT 2`;
  if (matches.length > 1) {
    throw new PartnerError('staff_not_eligible', 'More than one Quizball account uses this email; ask engineering to resolve it');
  }

  let userId: string;
  let account: StaffAddResult['account'];
  let inviteSent = false;
  if (matches.length === 1) {
    userId = matches[0].id;
    account = 'existing';
    await sql.begin((t) => enroll(asSql(t), config, actorUserId, userId, role, account));
  } else {
    const { authUserId, invited } = await getStaffInviter().invite(email);
    inviteSent = invited;
    account = 'invited';
    userId = await sql.begin(async (t) => {
      const tx = asSql(t);
      // Same lock as account creation on first sign-in (users.repo createWithIdentity), so the two cannot both
      // create a row for this identity.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'user_identity:supabase'}), hashtext(${authUserId}))`;
      const [linked] = await tx<{ user_id: string }[]>`
        SELECT user_id FROM user_identities WHERE provider = 'supabase' AND subject = ${authUserId}`;
      let id = linked?.user_id;
      if (!id) {
        // Staff hold no wallet: no coins, no tickets (the global refill skips partner_staff).
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO users (id, email, role, coins, tickets, onboarding_complete, is_ai)
          VALUES (gen_random_uuid(), ${email}, 'partner_staff', 0, 0, false, false)
          RETURNING id`;
        id = created.id;
        await tx`
          INSERT INTO user_identities (id, user_id, provider, subject, email)
          VALUES (gen_random_uuid(), ${id}, 'supabase', ${authUserId}, ${email})`;
      }
      await enroll(tx, config, actorUserId, id, role, account);
      return id;
    });
  }
  await invalidateByUserId(userId);
  const [row] = await memberRows(sql, config, userId);
  const [member] = await withSignIns([row]);
  return { member, account, inviteSent };
}

export async function updateStaffRole(
  config: PartnerConfig,
  actorUserId: string,
  userId: string,
  role: StaffRole,
): Promise<PartnerStaffMember> {
  await sql.begin(async (t) => {
    const tx = asSql(t);
    const [current] = await tx<{ role: StaffRole }[]>`
      SELECT role FROM partner_operator_memberships
      WHERE partner_slug = ${config.slug} AND user_id = ${userId}
      FOR UPDATE`;
    if (!current) throw new PartnerError('not_found', 'Not a staff member');
    if (current.role === role) return;
    await tx`
      UPDATE partner_operator_memberships SET role = ${role}
      WHERE partner_slug = ${config.slug} AND user_id = ${userId}`;
    await audit(tx, config, actorUserId, 'staff.update', userId, { role: current.role }, { role });
  });
  const [row] = await memberRows(sql, config, userId);
  const [member] = await withSignIns([row]);
  return member;
}

/** Removes the membership; with no membership left the account goes back to a plain user and loses the CMS. */
export async function removeStaff(config: PartnerConfig, actorUserId: string, userId: string): Promise<void> {
  await sql.begin(async (t) => {
    const tx = asSql(t);
    const [user] = await tx<{ email: string | null; role: string }[]>`
      SELECT email, role FROM users WHERE id = ${userId} FOR UPDATE`;
    const [membership] = await tx<{ role: StaffRole }[]>`
      DELETE FROM partner_operator_memberships
      WHERE partner_slug = ${config.slug} AND user_id = ${userId}
      RETURNING role`;
    if (!user || !membership) throw new PartnerError('not_found', 'Not a staff member');
    const [{ remaining }] = await tx<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM partner_operator_memberships WHERE user_id = ${userId}`;
    const demoted = remaining === 0 && user.role === 'partner_staff';
    if (demoted) await tx`UPDATE users SET role = 'user', updated_at = now() WHERE id = ${userId} AND role = 'partner_staff'`;
    await audit(tx, config, actorUserId, 'staff.remove', userId, { email: user.email, role: membership.role }, {
      userRole: demoted ? 'user' : user.role,
    });
  });
  // The cached user (60 s) still says partner_staff; drop it so access ends now, not at expiry.
  await invalidateByUserId(userId);
}

/** Test hook only. */
export function resetStaffSignInProbe(): void {
  authUsersReadable = null;
}
