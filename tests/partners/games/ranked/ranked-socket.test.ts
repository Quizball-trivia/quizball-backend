import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  gate: null as Promise<void> | null,
  fail: false,
}));
vi.mock('../../../../src/db/index.js', () => ({
  sql: Object.assign(async () => {
    await db.gate;
    if (db.fail) throw new Error('db down');
    return db.rows;
  }, { begin: vi.fn() }),
}));

const { connectPartnerSocket, installPartnerSocketGuard, partnerSocketAdmitted, PARTNER_SOCKET_EVENTS } =
  await import('../../../../src/modules/partners/games/ranked/ranked-realtime.js');
const pool = await import('../../../../src/modules/partners/games/ranked/ranked-pool.js');
const { resetPartnerConfigCache } = await import('../../../../src/modules/partners/partner-config.js');

type Middleware = (packet: unknown[], next: (err?: Error) => void) => void;

function fakeSocket() {
  const middlewares: Middleware[] = [];
  const socket = {
    data: { partner: { userId: 'u1', playerId: 'p1', sessionId: 's1' } } as Record<string, unknown>,
    use: (fn: Middleware) => middlewares.push(fn),
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  const send = (event: string) => new Promise<Error | undefined>((resolve) => middlewares[0]!([event, {}], resolve));
  return { socket, send };
}

describe('partner ranked socket guard', () => {
  beforeEach(() => {
    db.rows = [{ state: 'redeemed', end_reason: null, over: false, status: 'active' }];
    db.gate = null;
    db.fail = false;
  });

  it('lets only the ranked, draft, match and connection events through', async () => {
    const { socket, send } = fakeSocket();
    installPartnerSocketGuard(socket as never, Promise.resolve(true));
    for (const event of ['ranked:queue_join', 'draft:ban', 'draft:rejoin', 'draft:ui_ready', 'match:answer', 'connection:ping']) {
      expect(await send(event)).toBeUndefined();
    }
    for (const event of ['lobby:create', 'lobby:join_by_code', 'match:play_again', 'auction:search_start', 'grid:search_start',
      'duel:command', 'wl:subscribe', 'warmup:tap', 'dev:anything', 'lobby:challenge']) {
      expect((await send(event))?.message).toBe('PARTNER_EVENT_NOT_ALLOWED');
    }
    expect(PARTNER_SOCKET_EVENTS.has('match:play_again')).toBe(false);
  });

  it('ends the socket when the partner session is over', async () => {
    db.rows = [{ state: 'revoked', end_reason: 'replaced', over: false, status: 'active' }];
    const { socket, send } = fakeSocket();
    installPartnerSocketGuard(socket as never, Promise.resolve(true));
    expect((await send('ranked:queue_join'))?.message).toBe('PARTNER_SESSION_ENDED');
    expect(socket.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'replaced' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('a blocked player is ended as blocked (gameplay events re-check at most every few seconds)', async () => {
    db.rows = [{ state: 'redeemed', end_reason: null, over: false, status: 'blocked' }];
    const { socket, send } = fakeSocket();
    installPartnerSocketGuard(socket as never, Promise.resolve(true));
    expect(await send('match:answer')).toBeUndefined();
    await send('draft:ban');
    expect(socket.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'blocked' });
  });
});

describe('partner socket admission', () => {
  const LIVE = { state: 'redeemed', end_reason: null, over: false, status: 'active' };
  const REPLACED = { state: 'revoked', end_reason: 'replaced', over: false, status: 'active' };
  const io = { in: () => ({ fetchSockets: async () => [] }) } as never;

  beforeEach(() => {
    db.rows = [LIVE];
    db.gate = null;
    db.fail = false;
  });

  it('holds every packet until admission: a revoked handshake cannot leave the live session\'s queue', async () => {
    let open!: () => void;
    db.gate = new Promise((resolve) => { open = resolve; });
    db.rows = [REPLACED];
    const { socket, send } = fakeSocket();
    const admitted = connectPartnerSocket(io, socket as never);
    const settled = vi.fn();
    const leave = send('ranked:queue_leave').then((error) => {
      settled();
      return error;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    open();
    expect(await admitted).toBe(false);
    expect((await leave)?.message).toBe('PARTNER_NOT_ADMITTED');
    expect(socket.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'replaced' });
    expect(partnerSocketAdmitted(socket.data as never)).toBe(false);
  });

  it('session-ending commands re-check the session even right after admission', async () => {
    const { socket, send } = fakeSocket();
    expect(await connectPartnerSocket(io, socket as never)).toBe(true);
    expect(partnerSocketAdmitted(socket.data as never)).toBe(true);
    expect(await send('match:answer')).toBeUndefined();
    db.rows = [REPLACED];
    for (const event of ['ranked:queue_leave', 'match:forfeit', 'match:leave']) {
      expect((await send(event))?.message).toBe('PARTNER_SESSION_ENDED');
    }
  });

  it('an admission check that fails refuses everything and closes the socket', async () => {
    db.fail = true;
    const { socket, send } = fakeSocket();
    expect(await connectPartnerSocket(io, socket as never)).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    db.fail = false;
    expect((await send('match:answer'))?.message).toBe('PARTNER_NOT_ADMITTED');
    expect(partnerSocketAdmitted(socket.data as never)).toBe(false);
  });

  it('member sockets are unaffected', () => {
    expect(partnerSocketAdmitted({} as never)).toBe(true);
  });
});

describe('ranked pools', () => {
  beforeEach(() => {
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco', environment: 'test', inboundKeySha256: ['0'.repeat(64)], launchBaseUrl: 'https://example.test',
    });
    resetPartnerConfigCache();
  });

  it('members play in the public pool, partner players only in their partner pool', () => {
    expect(pool.rankedPoolForUser({ partner_slug: null })).toBe('public');
    expect(pool.rankedPoolForUser({ partner_slug: 'freecroco' })).toBe('freecroco-test');
    expect(pool.rankedPoolForUser({ partner_slug: 'other' })).toBeNull();
    expect(pool.activeRankedPools()).toEqual(['public', 'freecroco-test']);
  });

  it('cancelling by user reaches every pool queue, public keys first', () => {
    expect(pool.rankedCancelSearchKeys()).toEqual([
      'ranked:mm:queue', 'ranked:mm:timeouts', 'ranked:mm:user',
      'ranked:mm:pool:freecroco-test:queue', 'ranked:mm:pool:freecroco-test:timeouts',
    ]);
  });

  it('without partner config the partner pool is off', () => {
    delete process.env.PARTNER_FREECROCO_CONFIG;
    resetPartnerConfigCache();
    expect(pool.rankedPoolForUser({ partner_slug: 'freecroco' })).toBeNull();
    expect(pool.activeRankedPools()).toEqual(['public']);
  });
});
