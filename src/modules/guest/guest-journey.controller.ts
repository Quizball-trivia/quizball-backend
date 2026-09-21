import type { Request, Response } from 'express';
import { z } from 'zod';
import { guestJourneyRepo, guestTokenHash } from './guest-journey.repo.js';
import { detectCountryFromHeaders } from '../../core/geo.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { AuthenticationError } from '../../core/errors.js';
export const journeyActivitySchema = z.object({
  event_id: z.string().uuid(),
  step: z.enum(['play_started', 'play_completed', 'signup_started', 'onboarding_completed']),
  mode: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
export const guestJourneyController = {
  async activity(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as z.infer<typeof journeyActivitySchema>;
    // Persist play before the optional geo lookup: fast signup must see the actual prior play.
    await guestJourneyRepo.activity(req.guest!.id, null, body.event_id, body.step, body.mode);
    if (!(await guestJourneyRepo.hasCountry(req.guest!.id))) {
      const country = await detectCountryFromHeaders({}, resolveTrustedClientIp(req)).catch(() => null);
      if (country) await guestJourneyRepo.setCountry(req.guest!.id, country);
    }
    res.sendStatus(204);
  },
  async link(req: Request, res: Response): Promise<void> {
    const hash = guestTokenHash(req.headers['x-guest-token']);
    if (!hash || req.user!.is_guest || req.headers['x-journey-member-id'] !== req.user!.id) throw new AuthenticationError('Invalid guest link');
    const link = await guestJourneyRepo.link(hash, req.user!.id);
    // Do not disclose who claimed a session on a shared browser.
    res.json({ linked: Boolean(link), link_type: link?.link_type ?? null });
  },
  async memberActivity(req: Request, res: Response): Promise<void> {
    if (req.user!.is_guest || req.headers['x-journey-member-id'] !== req.user!.id) throw new AuthenticationError('Member required');
    const body = req.validated.body as z.infer<typeof journeyActivitySchema>;
    await guestJourneyRepo.memberActivity(req.user!.id, body.event_id, body.step, body.mode);
    res.sendStatus(204);
  },
};
