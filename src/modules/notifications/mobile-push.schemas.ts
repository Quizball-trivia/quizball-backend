import { z } from 'zod';

export const pushLocaleSchema = z.enum(['en','ka','es','tr']);
export const pushTimezoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'A valid IANA timezone is required');
export const pushTokenSchema = z.string().max(256).regex(/^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]{10,200}\]$/);
export const registerPushDeviceSchema = z.object({
  expoPushToken: pushTokenSchema, platform: z.enum(['ios','android']),
  clientRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  locale: pushLocaleSchema.default('en'), timezone: pushTimezoneSchema.default('UTC'),
  appVersion: z.string().max(50).optional(),
}).strict();
export const unregisterPushDeviceSchema = z.object({ expoPushToken: pushTokenSchema,
  platform: z.enum(['ios','android']), clientRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const pushPreferencesSchema = z.object({
  matchInvitesEnabled: z.boolean(), dailyRemindersEnabled: z.boolean(), newGamesEnabled: z.boolean(),
  dailyReminderHour: z.number().int().min(0).max(23), timezone: pushTimezoneSchema,
});
export const updatePushPreferencesSchema = pushPreferencesSchema.partial().strict().refine(v => Object.keys(v).length > 0);
export const pushRouteSchema = z.enum(['/(tabs)', '/(tabs)/events', '/(tabs)/leaderboard',
  '/(app)/daily/challenges', '/(game)/training', '/(game)/grid-training', '/(tabs)/store']);
const translations = (max: number) => z.object({ en: z.string().min(1).max(max), ka: z.string().min(1).max(max),
  es: z.string().min(1).max(max), tr: z.string().min(1).max(max) }).strict();
export const pushCampaignSchema = z.object({
  campaignId: z.string().uuid(), title: translations(90), body: translations(250),
  route: pushRouteSchema, confirmSend: z.literal(true),
}).strict();
export type PushDeviceInput = z.infer<typeof registerPushDeviceSchema>;
export type PushUnregisterInput = z.infer<typeof unregisterPushDeviceSchema>;
export type PushPreferences = z.infer<typeof pushPreferencesSchema>;
export type PushPreferencesUpdate = z.infer<typeof updatePushPreferencesSchema>;
export type PushCampaignInput = z.infer<typeof pushCampaignSchema>;
