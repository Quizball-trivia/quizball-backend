import { createHash } from 'node:crypto';
import { config } from '../../core/config.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { FEEDBACK_CATEGORY_LABEL, type FeedbackCategory } from '../feedback/feedback.schemas.js';

// Feedback (tables harness.feedback and harness.feedback_reads): what players
// tell us, in one place. Three ways in: the contact form (saved when it is
// sent; it used to be an email and nothing else), the Season 3 idea survey and
// the comment left after a game (both copied from the game's own tables).
// The Feedback Reader (job kind feedback_read) translates what is neither
// Georgian nor English and writes a recap. It gets the words only: never a
// player's name or email.

type Db = typeof sql;

export type FeedbackSource = 'form' | 'season3' | 'game';

/** Pure: what makes a form message the same message when it arrives twice (a retry, or the same email imported). */
export function formRef(email: string | null | undefined, message: string): string {
  return createHash('sha256').update(`${(email ?? '').trim().toLowerCase()}\n${message.trim()}`).digest('hex');
}

export interface FormFeedback {
  category: FeedbackCategory;
  message: string;
  email?: string | null;
  nickname?: string | null;
  userId?: string | null;
  context?: string | null;
  attachments?: string[];
  receivedAt?: Date;
}

const cut = (value: string | null | undefined, max: number) => {
  const v = (value ?? '').trim();
  return v ? v.slice(0, max) : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saves one message from the contact form. Saving the same message twice keeps one. Returns whether it was new. */
async function saveForm(f: FormFeedback): Promise<boolean> {
  const message = f.message.trim().slice(0, 4000);
  if (!message) return false;
  const email = cut(f.email, 254);
  const userId = f.userId && UUID.test(f.userId) ? f.userId : null;
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness.feedback (source, source_ref, category, message, nickname, email, user_id, context, attachments, received_at)
    SELECT 'form', ${formRef(email, message)}, ${f.category}, ${message}, ${cut(f.nickname, 120)}, ${email},
           (SELECT id FROM public.users WHERE id = ${userId}::uuid), ${cut(f.context, 500)},
           ${(f.attachments ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 5)}::text[], ${f.receivedAt ?? new Date()}
    ON CONFLICT (source, source_ref) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

// ── what the game already holds ────────────────────────────────────────────

let syncedAt = 0;
const SYNC_EVERY_MS = 60_000;

/** Copies new Season 3 ideas and after-game comments in. A comment a player rewrote replaces the old one. */
async function sync(force = false): Promise<void> {
  if (!force && Date.now() - syncedAt < SYNC_EVERY_MS) return;
  syncedAt = Date.now();
  await sql`
    INSERT INTO harness.feedback (source, source_ref, category, message, nickname, user_id, locale, received_at)
    SELECT 'season3', r.id::text, 'idea', left(btrim(r.idea), 4000), left(u.nickname, 120), r.user_id, r.locale, r.created_at
      FROM public.season3_survey_responses r
      LEFT JOIN public.users u ON u.id = r.user_id
     WHERE r.kind = 'idea' AND length(btrim(coalesce(r.idea, ''))) > 0 AND r.created_at > now() - interval '30 days'
    ON CONFLICT (source, source_ref) DO NOTHING`;
  await sql`
    INSERT INTO harness.feedback AS f (source, source_ref, category, message, nickname, user_id, game, rating, locale, received_at)
    SELECT 'game', g.id::text, 'rating', left(btrim(g.comment), 4000), left(u.nickname, 120), g.user_id, g.game, g.rating, g.locale, g.updated_at
      FROM public.game_feedback g
      LEFT JOIN public.users u ON u.id = g.user_id
     WHERE length(btrim(coalesce(g.comment, ''))) > 0 AND g.updated_at > now() - interval '30 days'
    ON CONFLICT (source, source_ref) DO UPDATE
      -- New words or new stars: either way it is news to the next recap (new words also reset the translation,
      -- which the table's own trigger does).
      SET message = EXCLUDED.message, rating = EXCLUDED.rating, received_at = EXCLUDED.received_at, arrived_at = clock_timestamp(), updated_at = now()
    WHERE f.message IS DISTINCT FROM EXCLUDED.message OR f.rating IS DISTINCT FROM EXCLUDED.rating`;
  // A player who sends their rating again without a comment took the comment back: it goes from here too
  // (so does the comment of an account that was deleted).
  const withdrawn = await sql<Array<{ since: Date }>>`
    DELETE FROM harness.feedback f
     WHERE f.source = 'game'
       AND NOT EXISTS (SELECT 1 FROM public.game_feedback g WHERE g.id::text = f.source_ref AND length(btrim(coalesce(g.comment, ''))) > 0)
    RETURNING f.created_at AS since`;
  // What a player took back or changed must not live on in a recap, finished or being written. A recap started
  // after a comment came in may quote it, so those go when the comment is taken back; a recap started before a
  // comment was rewritten or re-rated may quote the old words or stars, so those go too. (A round in progress loses its job with it and
  // saves nothing.) The next round writes a fresh recap from what is left; with nothing left there is none.
  const gone = await sql<Array<{ id: string }>>`
    DELETE FROM harness.feedback_reads r
     WHERE r.status IN ('ready', 'writing')
       AND (r.created_at >= ${withdrawn.length ? new Date(Math.min(...withdrawn.map((w) => new Date(w.since).getTime())) - 1000) : null}::timestamptz
         OR EXISTS (SELECT 1 FROM harness.feedback f
                     WHERE f.source = 'game' AND f.arrived_at > f.created_at + interval '2 seconds' AND f.arrived_at > r.created_at))
    RETURNING r.id`;
  if (gone.length > 0) {
    await sql`INSERT INTO harness.events (type, level, message) VALUES ('feedback', 'info', 'A player took back or rewrote a comment: the recap written with it was removed and will be written again')`;
  }
}

// ── reading ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  number: number;
  source: FeedbackSource;
  category: string;
  message: string;
  nickname: string | null;
  email: string | null;
  user_id: string | null;
  context: string | null;
  attachments: string[];
  game: string | null;
  rating: number | null;
  locale: string | null;
  language: string | null;
  english: string | null;
  received_at: Date | string;
}

/** Pure: one piece of feedback as HQ shows it. `english` is only there when the original is neither Georgian nor English. */
export function feedbackView(r: Row) {
  return {
    id: r.id,
    number: r.number,
    source: r.source,
    category: r.category,
    message: r.message,
    // NULL = the reader has not got to it yet.
    language: r.language,
    english: r.language && r.language !== 'ka' && r.language !== 'en' ? r.english : null,
    nickname: r.nickname,
    email: r.email,
    hasAccount: r.user_id !== null,
    context: r.context,
    attachments: (r.attachments ?? []).filter((u) => /^https:\/\//.test(u)),
    game: r.game,
    rating: r.rating,
    locale: r.locale,
    receivedAt: new Date(r.received_at).toISOString(),
  };
}

export interface FeedbackRecap {
  summary: string;
  /** What players ask for or complain about, most often first. `refs` are feedback numbers. */
  themes: Array<{ title: string; count: number; points: string[]; refs: number[] }>;
  praise: string[];
  urgent: string[];
}

interface ReadRow {
  id: string;
  number: number;
  status: 'writing' | 'ready' | 'failed';
  recap: FeedbackRecap | null;
  items: number;
  translated: number;
  newest_at: Date | string | null;
  requested_by: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** Pure: a round of the reader as HQ shows it. */
export function readView(r: ReadRow) {
  return { id: r.id, number: r.number, status: r.status, recap: r.recap, items: r.items, translated: r.translated, newestAt: iso(r.newest_at), requestedBy: r.requested_by, error: r.error, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! };
}

/**
 * Pure: a message as the reader may see it. A player sometimes types how to reach them into the message itself;
 * the reader does not need that, so addresses and long numbers are blanked. HQ keeps and shows the original.
 */
export function withoutContacts(text: string): string {
  return text
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[email]')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/(?<![\p{L}\p{N}])@[\p{L}\p{N}_.]{3,}/gu, '[handle]')
    // A phone number: written with a plus, or nine or more digits in groups. Dates and scores (dots, colons) are left.
    .replace(/\+\d[\d\s().-]{7,}\d/g, '[number]')
    .replace(/(?<!\d)(?:\d[ -]?){9,}(?!\d)/g, (m) => `[number]${/[ -]$/.test(m) ? m.slice(-1) : ''}`);
}

const TEXT_IN_RECAP = 700;
const READ_AT_ONCE = 60;
const TRANSLATE_CHARS = 24_000;
const RECAP_FROM = 250;

/** Pure: what the reader is given. No names, no emails, no account ids, and no contact details typed into a message: the words, when, and what kind. */
export function readerInput(today: string, unread: Array<Pick<Row, 'id' | 'message'>>, recent: Row[]) {
  return {
    today,
    // To translate. `hash` lets the database refuse a translation of a message that changed meanwhile.
    // The hash is of the message as stored, not as shown to the reader.
    toRead: unread.map((r) => ({ id: r.id, hash: createHash('md5').update(r.message).digest('hex'), text: withoutContacts(r.message) })),
    // Everything recent, newest first, for the recap. `n` is the number a person sees on the page.
    recent: recent.map((r) => ({
      n: r.number,
      date: new Date(r.received_at).toISOString().slice(0, 10),
      kind: r.category,
      ...(r.game ? { game: r.game } : {}),
      ...(r.rating ? { stars: r.rating } : {}),
      text: withoutContacts(r.english ?? r.message).slice(0, TEXT_IN_RECAP),
    })),
  };
}

/** Pure: as many of the unread as one round can translate well (always at least one). The rest wait for the next round. */
export function withinBudget<T extends { message: string }>(unread: T[], budget = TRANSLATE_CHARS): T[] {
  const take: T[] = [];
  let used = 0;
  for (const r of unread) {
    if (take.length && used + r.message.length > budget) break;
    take.push(r);
    used += r.message.length;
  }
  return take;
}

const AGENT = 'feedback-reader';
const tbilisiDay = (at: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(at);

/** Whether there is anything the last finished recap has not seen. */
async function somethingNew(db: Db): Promise<boolean> {
  const [row] = await db<Array<{ fresh: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM harness.feedback f
       WHERE f.language IS NULL
          OR f.arrived_at > coalesce((SELECT max(newest_at) FROM harness.feedback_reads WHERE status = 'ready'), '-infinity'::timestamptz)
    ) AS fresh`;
  return row?.fresh === true;
}

/** One try at starting a round. `due`: a scheduled start, checked again under the lock; null when nothing is new. */
async function startOnce(by: string, due = false) {
  // One snapshot for the whole start: what the reader is given and the mark of what the recap has seen are read by
  // several statements, and a message arriving between two of them would be marked as seen without being in the
  // input. Under repeatable read every statement sees the same rows.
  return sql.begin('isolation level repeatable read', async (t) => {
    const tx = t as unknown as Db;
    // One start at a time, across every server.
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_feedback_read'))`;
    const [writing] = await tx<Array<{ id: string }>>`SELECT id FROM harness.feedback_reads WHERE status = 'writing' LIMIT 1`;
    if (writing) {
      if (due) return null;
      throw new ConflictError('It is already reading. The recap will be here in a few minutes.');
    }
    if (due && !(await somethingNew(tx))) return null;
    const [a] = await tx<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${AGENT}`;
    if (!a) throw new NotFoundError('The Feedback Reader is not set up.');
    if (a.status !== 'active') throw new ConflictError('The Feedback Reader is paused.');
    const columns = tx`id, number, source, category, message, nickname, email, user_id, context, attachments, game, rating, locale, language, english, received_at`;
    const unread = withinBudget(await tx<Row[]>`SELECT ${columns} FROM harness.feedback WHERE language IS NULL ORDER BY received_at DESC LIMIT ${READ_AT_ONCE}`);
    const recent = await tx<Row[]>`
      SELECT ${columns} FROM harness.feedback WHERE received_at > now() - interval '180 days' ORDER BY received_at DESC LIMIT ${RECAP_FROM}`;
    if (!recent.length && !unread.length) throw new ConflictError('There is no feedback to read yet.');
    // The latest arrival there is right now, taken from the rows by the database (a date passed through here would
    // lose its microseconds, and the newest row would then look newer than the recap for ever).
    const [row] = await tx<ReadRow[]>`
      INSERT INTO harness.feedback_reads (items, newest_at, requested_by)
      VALUES (${recent.length}, (SELECT max(arrived_at) FROM harness.feedback), ${by})
      RETURNING *`;
    // Ahead of the content queue (0 is first, 9 last): a person may be waiting to read it.
    await tx`
      INSERT INTO harness.jobs (kind, agent_slug, feedback_read_id, priority, input)
      VALUES ('feedback_read', ${AGENT}, ${row!.id}, ${by === 'schedule' ? 1 : 0}, ${sql.json(readerInput(tbilisiDay(), unread, recent) as never)})`;
    await tx`INSERT INTO harness.events (type, level, message) VALUES ('feedback', 'info', ${`Feedback read ${row!.number} started, asked by ${by}`.slice(0, 1000)})`;
    return readView(row!);
  });
}

/**
 * Starts a round of the reader. `due`: a scheduled start; null when nothing is new or one is already being written.
 * Two starts at the same moment: the second waits for the first, but under its one snapshot it cannot see what the
 * first just saved, so it is the database's rule (one round being written at a time) that stops it.
 */
async function start(by: string, due = false) {
  try {
    return await startOnce(by, due);
  } catch (err) {
    if ((err as { code?: string })?.code !== '23505' && (err as { code?: string })?.code !== '40001') throw err;
    if (due) return null;
    throw new ConflictError('It is already reading. The recap will be here in a few minutes.');
  }
}

// ── past emails (Resend keeps what it sent for 30 days) ────────────────────

const RESEND = 'https://api.resend.com';
const PAUSE_MS = 600;
const MAX_PAGES = 80;
const KEEP_DAYS = 31;

const unescapeHtml = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const CATEGORY_OF_SUBJECT = new Map(Object.entries(FEEDBACK_CATEGORY_LABEL).map(([key, label]) => [`[QuizBall] ${label}`, key as FeedbackCategory]));

/** Pure: whether an email in the sent list is one of the contact form's (by its subject and who it went to). */
export function isFeedbackEmail(email: { subject?: unknown; to?: unknown }, recipient: string): boolean {
  if (typeof email.subject !== 'string' || !CATEGORY_OF_SUBJECT.has(email.subject.trim())) return false;
  const to = Array.isArray(email.to) ? email.to : typeof email.to === 'string' ? [email.to] : [];
  return to.some((t) => typeof t === 'string' && t.toLowerCase().includes(recipient.toLowerCase()));
}

/** Pure: reads a contact-form email (as feedback.service writes it) back into its fields. Null when it is not one. */
export function parseFeedbackEmail(subject: string, html: string): Omit<FormFeedback, 'receivedAt'> | null {
  const category = CATEGORY_OF_SUBJECT.get(subject.trim());
  const message = /<p><strong>Message:<\/strong><\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
  if (!category || message === undefined) return null;
  const field = (label: string) => {
    const m = new RegExp(`<p><strong>${label}:</strong>\\s*([\\s\\S]*?)</p>`).exec(html)?.[1];
    return m === undefined ? null : unescapeHtml(m).trim() || null;
  };
  const user = field('User');
  return {
    category,
    message: unescapeHtml(message),
    email: field('Reply-to'),
    nickname: field('Nickname'),
    userId: user ? (/\(([0-9a-f-]{36})\)\s*$/i.exec(user)?.[1] ?? null) : null,
    context: field('Context'),
    attachments: [...html.matchAll(/<a href="(https:\/\/[^"]+)">Attachment \d+<\/a>/g)].map((m) => unescapeHtml(m[1]!)),
  };
}

export interface ImportState {
  running: boolean;
  /** Emails looked at, feedback emails found, and how many of those were not here yet. */
  scanned: number;
  found: number;
  added: number;
  error: string | null;
  /** It stopped at its limit with more emails to look at; asking again carries on from there. */
  partial: boolean;
  startedBy: string | null;
  finishedAt: string | null;
}
const importState: ImportState = { running: false, scanned: 0, found: 0, added: 0, error: null, partial: false, startedBy: null, finishedAt: null };
/** Where a partial import stopped (the email service's cursor), so the next one carries on instead of starting over. */
let importCursor: string | null = null;

/**
 * Pure: when the email service says an email was sent, in milliseconds; NaN when it cannot be read. It writes
 * "2026-04-03 22:13:42.674981+00": a space where the standard has a T, and an offset with no minutes.
 */
export function resendTime(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  return new Date(value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).getTime();
}

/** Where bringing in the past emails stands, kept across restarts (policy `feedback.past_emails`). */
export interface PastEmailsProgress {
  /** A run got to the end, or cannot ever (the key may not read): nothing more is tried by itself. */
  done?: boolean;
  attempts?: number;
  lastAt?: string;
  /** Where an unfinished run stopped. */
  cursor?: string | null;
  /** A run is going on some server. Believed only while `lastAt` is fresh: a running import writes it with every page. */
  running?: boolean;
  error?: string | null;
}
const IMPORT_TRIES = 12;
const IMPORT_EVERY_MS = 25 * 60_000;

/** Pure: whether the loop should start (or carry on) bringing in the past emails now. */
export function importIsDue(p: PastEmailsProgress, now: number): boolean {
  if (p.done || (p.attempts ?? 0) >= IMPORT_TRIES) return false;
  const last = p.lastAt ? Date.parse(p.lastAt) : NaN;
  return !Number.isFinite(last) || now - last >= IMPORT_EVERY_MS;
}

/** Merges `change` into the saved progress in one statement (no read first, so two servers never overwrite each other's fields). */
async function savePastEmailsProgress(change: PastEmailsProgress): Promise<void> {
  await sql`
    INSERT INTO harness.policies (key, value, note)
    VALUES ('feedback.past_emails', ${sql.json(change as never)}, ${PROGRESS_NOTE})
    ON CONFLICT (key) DO UPDATE SET value = harness.policies.value || EXCLUDED.value, updated_at = now()`;
}
const PROGRESS_NOTE = 'Where bringing in the contact-form emails from before the Feedback page stands. Kept by the server.';

/**
 * Claims the next scheduled try, in the database, so that of several servers on the same round exactly one starts:
 * the try is counted and its time written in the same statement that checks it is due. Returns the progress as
 * claimed, or null when it is not due or another server took it.
 */
async function claimScheduledImport(): Promise<PastEmailsProgress | null> {
  await sql`INSERT INTO harness.policies (key, value, note) VALUES ('feedback.past_emails', '{}'::jsonb, ${PROGRESS_NOTE}) ON CONFLICT (key) DO NOTHING`;
  const [row] = await sql<Array<{ value: PastEmailsProgress }>>`
    UPDATE harness.policies
       SET value = value || jsonb_build_object('running', true, 'attempts', coalesce((value->>'attempts')::int, 0) + 1, 'lastAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           updated_at = now()
     WHERE key = 'feedback.past_emails'
       AND coalesce((value->>'done')::boolean, false) = false
       AND coalesce((value->>'attempts')::int, 0) < ${IMPORT_TRIES}
       AND (value->>'lastAt' IS NULL OR (value->>'lastAt')::timestamptz <= now() - make_interval(secs => ${IMPORT_EVERY_MS / 1000}))
    RETURNING value`;
  return row?.value ?? null;
}

/** How long a running import is believed without a sign of life. It gives one at least every minute. */
const IMPORT_ALIVE = '10 minutes';
const BEAT_EVERY_MS = 60_000;
let lastBeat = 0;

/** A running import's sign of life, at most once a minute: while it is fresh, no other server starts a run or a recap beside it. */
async function beat(extra: PastEmailsProgress = {}): Promise<void> {
  if (Date.now() - lastBeat < BEAT_EVERY_MS && Object.keys(extra).length === 0) return;
  lastBeat = Date.now();
  await savePastEmailsProgress({ ...extra, lastAt: new Date().toISOString() }).catch((err: unknown) => logger.warn({ err }, 'Feedback import progress not saved'));
}

/**
 * A person's start takes the same place in the database as a scheduled one, without being counted as a try: null
 * when an import is alive on some server.
 */
async function claimManualImport(): Promise<PastEmailsProgress | null> {
  await sql`INSERT INTO harness.policies (key, value, note) VALUES ('feedback.past_emails', '{}'::jsonb, ${PROGRESS_NOTE}) ON CONFLICT (key) DO NOTHING`;
  const [row] = await sql<Array<{ value: PastEmailsProgress }>>`
    UPDATE harness.policies
       SET value = value || jsonb_build_object('running', true, 'lastAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), updated_at = now()
     WHERE key = 'feedback.past_emails'
       AND NOT (coalesce((value->>'running')::boolean, false) AND (value->>'lastAt')::timestamptz > now() - ${IMPORT_ALIVE}::interval)
    RETURNING value`;
  return row?.value ?? null;
}

/** Whether an import is running on this or any other server, by its last sign of life. */
async function importRunningSomewhere(): Promise<boolean> {
  if (importState.running) return true;
  const [row] = await sql<Array<{ busy: boolean }>>`
    SELECT true AS busy FROM harness.policies
     WHERE key = 'feedback.past_emails' AND coalesce((value->>'running')::boolean, false)
       AND (value->>'lastAt')::timestamptz > now() - ${IMPORT_ALIVE}::interval`;
  return row?.busy === true;
}

/** The email service refused the key for reading: no later try can do better. */
const CANNOT_READ = 'may only send emails';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resend(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${RESEND}${path}`, { headers: { Authorization: `Bearer ${config.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt < 4) {
      await pause(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error('The email service key on the server may only send emails, not read the ones already sent. Past emails cannot be brought in with it.');
    if (!res.ok) throw new Error(`The email service answered ${res.status}.`);
    return (await res.json()) as Record<string, unknown>;
  }
}

async function runImport(): Promise<void> {
  const recipient = config.FEEDBACK_RECIPIENT_EMAIL;
  const oldest = Date.now() - KEEP_DAYS * 86_400_000;
  let after: string | null = importCursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    // Where to carry on if this run stops here, for whatever reason: kept here, and in the database so that a
    // server that dies mid-run does not send the next try back to the start.
    importCursor = after;
    if (page > 0) await beat({ cursor: after });
    const list = await resend(`/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const rows = (Array.isArray(list.data) ? list.data : []) as Array<{ id?: unknown; subject?: unknown; to?: unknown; created_at?: unknown }>;
    if (!rows.length) {
      importCursor = null;
      return;
    }
    let pastTheEnd = false;
    for (const row of rows) {
      importState.scanned++;
      // A page full of feedback emails, each waited for, can take many minutes: keep showing a sign of life.
      await beat();
      const at = resendTime(row.created_at);
      if (Number.isFinite(at) && at < oldest) pastTheEnd = true;
      if (typeof row.id !== 'string' || !isFeedbackEmail(row, recipient)) continue;
      await pause(PAUSE_MS);
      const full = await resend(`/emails/${encodeURIComponent(row.id)}`);
      const parsed = typeof full.html === 'string' ? parseFeedbackEmail(String(row.subject), full.html) : null;
      if (!parsed) continue;
      importState.found++;
      // An email whose date cannot be read is left out: saved as "now" it would pose as new feedback.
      if (!Number.isFinite(at)) continue;
      if (await saveForm({ ...parsed, receivedAt: new Date(at) })) importState.added++;
    }
    const last = rows[rows.length - 1]?.id;
    if (pastTheEnd || list.has_more !== true || typeof last !== 'string') {
      importCursor = null;
      return;
    }
    after = last;
    await pause(PAUSE_MS);
  }
  // The limit of one go, with emails of the last 30 days still unseen: say so, and remember where to carry on.
  importCursor = after;
  importState.partial = true;
}

// ── the module ─────────────────────────────────────────────────────────────

export const feedbackInbox = {
  saveForm,
  sync,

  /** Everything recent, the newest recap, and where the reader stands. */
  async list() {
    await sync().catch((err) => logger.warn({ err }, 'Feedback sync skipped'));
    const rows = await sql<Row[]>`
      SELECT id, number, source, category, message, nickname, email, user_id, context, attachments, game, rating, locale, language, english, received_at
        FROM harness.feedback ORDER BY received_at DESC LIMIT 400`;
    const [counts] = await sql<Array<{ total: number; waiting: number; fresh: number; last7: number; last30: number; bugs: number; translated: number }>>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE received_at > now() - interval '7 days')::int AS last7,
             count(*) FILTER (WHERE received_at > now() - interval '30 days')::int AS last30,
             count(*) FILTER (WHERE category = 'bug')::int AS bugs,
             count(*) FILTER (WHERE english IS NOT NULL AND language NOT IN ('ka', 'en'))::int AS translated,
             count(*) FILTER (WHERE language IS NULL)::int AS waiting,
             count(*) FILTER (WHERE arrived_at > coalesce((SELECT max(newest_at) FROM harness.feedback_reads WHERE status = 'ready'), '-infinity'::timestamptz))::int AS fresh
        FROM harness.feedback`;
    const [ready] = await sql<ReadRow[]>`SELECT * FROM harness.feedback_reads WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1`;
    const [latest] = await sql<ReadRow[]>`SELECT * FROM harness.feedback_reads ORDER BY created_at DESC LIMIT 1`;
    return {
      items: rows.map(feedbackView),
      total: counts?.total ?? 0,
      // Counted over everything, not only the rows listed above.
      stats: { last7Days: counts?.last7 ?? 0, last30Days: counts?.last30 ?? 0, bugs: counts?.bugs ?? 0, translated: counts?.translated ?? 0 },
      // Not read by the reader yet (so: no translation yet), and arrived since the recap was written.
      waiting: counts?.waiting ?? 0,
      newSinceRecap: counts?.fresh ?? 0,
      recap: ready ? readView(ready) : null,
      reading: latest?.status === 'writing',
      // The last round failed and nothing finished since.
      readError: latest?.status === 'failed' ? (latest.error ?? 'The reader could not finish.') : null,
      pastEmails: { ...importState, possible: Boolean(config.RESEND_API_KEY) },
    };
  },

  /** A person asks for a fresh read now. */
  async read(by: string) {
    await sync(true);
    return (await start(by))!;
  },

  /**
   * The emails from before this page existed are brought in by themselves (the email service only keeps about 30
   * days, so waiting for a person to press the button loses some). It is tried on the loop's rounds until one run
   * gets to the end: a run that stopped part-way is carried on from where it stopped, also after a restart, and one
   * that failed is tried again, up to a limit. Where it stands is kept in the policies table.
   */
  async importDue(): Promise<boolean> {
    if (!config.RESEND_API_KEY || (await importRunningSomewhere())) return false;
    const claimed = await claimScheduledImport();
    if (!claimed) return false;
    // Carry on from where the last run stopped, also when it was another server's or before a restart.
    importCursor = claimed.cursor ?? null;
    await this.importPastEmails('schedule', true);
    return true;
  },

  /** Starts a read when something new came in. Not more than once an hour, and after a failed round not for six hours from when it failed. */
  async runDue(): Promise<boolean> {
    // While past emails are coming in (on any server), wait: a recap started now would miss them and hold the next
    // one back an hour.
    if (await importRunningSomewhere()) return false;
    await sync(true);
    if (!(await somethingNew(sql))) return false;
    const [recent] = await sql<Array<{ id: string }>>`
      SELECT id FROM harness.feedback_reads
       WHERE (status = 'failed' AND updated_at > now() - interval '6 hours')
          OR (status <> 'failed' AND created_at > now() - interval '60 minutes')
       LIMIT 1`;
    if (recent) return false;
    return (await start('schedule', true)) !== null;
  },

  /** Brings in the contact-form emails the email service still holds (about the last 30 days). Runs on its own; the page shows how far it is. */
  async importPastEmails(by: string, claimed = false): Promise<ImportState> {
    if (!config.RESEND_API_KEY) throw new ConflictError('The server has no email service key.');
    if (importState.running) throw new ConflictError('It is already bringing them in.');
    // A scheduled run took its place when it was claimed; a person's run takes it here, or is told one is going on.
    if (!claimed) {
      const mine = await claimManualImport();
      if (!mine) throw new ConflictError('It is already bringing them in.');
      // A person asks for everything again: from the newest email, unless an unfinished run left a place to carry on from.
      importCursor = importState.partial ? importCursor : (mine.done ? null : (importCursor ?? mine.cursor ?? null));
    }
    lastBeat = Date.now();
    Object.assign(importState, { running: true, scanned: 0, found: 0, added: 0, error: null, partial: false, startedBy: by, finishedAt: null });
    void runImport()
      .catch((err: unknown) => {
        importState.error = err instanceof Error ? err.message.slice(0, 300) : 'It stopped.';
        logger.warn({ err }, 'Feedback import stopped');
      })
      .finally(() => {
        importState.running = false;
        importState.finishedAt = new Date().toISOString();
        // Done when it reached the end, or when the key cannot read at all. Otherwise the loop tries again, from the cursor.
        const done = (!importState.error && !importState.partial) || Boolean(importState.error?.includes(CANNOT_READ));
        void savePastEmailsProgress({ running: false, done, cursor: done ? null : importCursor, error: importState.error }).catch((err: unknown) => logger.warn({ err }, 'Feedback import progress not saved'));
        void sql`INSERT INTO harness.events (type, level, message) VALUES ('feedback', ${importState.error ? 'warn' : 'info'},
          ${`Past feedback emails: ${importState.added} new of ${importState.found} found (${importState.scanned} emails looked at), asked by ${by}${importState.error ? `. Stopped: ${importState.error}` : importState.partial ? '. Not finished: there are more emails to look at' : ''}`.slice(0, 1000)})`.catch(() => undefined);
      });
    return { ...importState };
  },
};
