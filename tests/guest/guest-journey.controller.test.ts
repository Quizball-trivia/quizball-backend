import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ link: vi.fn(), memberActivity: vi.fn(), activity: vi.fn(), hasCountry: vi.fn(), setCountry: vi.fn() }));
vi.mock('../../src/modules/guest/guest-journey.repo.js', () => ({ guestJourneyRepo: m, guestTokenHash: (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? 'hash' : null }));
vi.mock('../../src/core/geo.js', () => ({ detectCountryFromHeaders: vi.fn().mockResolvedValue('GE') }));
import { guestJourneyController, journeyActivitySchema } from '../../src/modules/guest/guest-journey.controller.js';
beforeEach(() => { vi.clearAllMocks(); m.link.mockResolvedValue({ link_type: 'signup' }); });
const res = () => ({ json: vi.fn(), sendStatus: vi.fn() });
describe('guest link member authentication boundary', () => {
  it('rejects a stale browser identity after a different member signs in', async () => {
    await expect(guestJourneyController.link({ headers: { 'x-guest-token': 'a'.repeat(64), 'x-journey-member-id': 'old' }, user: { id: 'new', is_guest: false } } as never, res() as never)).rejects.toThrow('Invalid guest link');
    expect(m.link).not.toHaveBeenCalled();
  });
  it('does not accept a guest principal as the member', async () => {
    await expect(guestJourneyController.link({ headers: { 'x-guest-token': 'a'.repeat(64), 'x-journey-member-id': 'guest' }, user: { id: 'guest', is_guest: true } } as never, res() as never)).rejects.toThrow();
  });
  it('always takes the member ID from the verified auth middleware', async () => {
    await guestJourneyController.link({ headers: { 'x-guest-token': 'a'.repeat(64), 'x-journey-member-id': 'member' }, user: { id: 'member', is_guest: false } } as never, res() as never);
    expect(m.link).toHaveBeenCalledWith('hash', 'member');
  });
  it('rejects arbitrary steps and invalid retry identifiers', () => {
    expect(journeyActivitySchema.safeParse({ event_id: 'fake', step: 'converted', mode: 'ranked' }).success).toBe(false);
  });
});
