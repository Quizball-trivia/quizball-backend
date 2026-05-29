import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';

export type SmsDeliveryStatus =
  | 'submitted'
  | 'accepted'
  | 'dry_run'
  | 'failed'
  | 'Delivered'
  | 'Undelivered'
  | 'Expired'
  | 'Pending'
  | 'Unknown';

export interface UpsertSmsDeliveryInput {
  reference: string;
  destination: string;
  status: SmsDeliveryStatus;
  errorCode?: number | null;
  errorMessage?: string | null;
  rawCallback?: Record<string, unknown> | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
}

export const smsDeliveryRepo = {
  async upsert(input: UpsertSmsDeliveryInput): Promise<void> {
    await sql`
      INSERT INTO sms_delivery_events (
        reference,
        destination,
        status,
        error_code,
        error_message,
        raw_callback,
        sent_at,
        delivered_at
      )
      VALUES (
        ${input.reference},
        ${input.destination},
        ${input.status},
        ${input.errorCode ?? null},
        ${input.errorMessage ?? null},
        ${sql.json((input.rawCallback ?? null) as Json)},
        ${input.sentAt ?? null},
        ${input.deliveredAt ?? null}
      )
      ON CONFLICT (reference)
      DO UPDATE SET
        destination = EXCLUDED.destination,
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        raw_callback = COALESCE(EXCLUDED.raw_callback, sms_delivery_events.raw_callback),
        sent_at = COALESCE(EXCLUDED.sent_at, sms_delivery_events.sent_at),
        delivered_at = COALESCE(EXCLUDED.delivered_at, sms_delivery_events.delivered_at),
        updated_at = NOW()
    `;
  },
};
