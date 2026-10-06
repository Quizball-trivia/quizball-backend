/** A partner's init response is kept until its token is used or expires, so a retry of the same request gets the
 *  same answer (contract §4.1). It holds a live one-time token, so it is stored encrypted (AES-256-GCM, key derived
 *  from PARTNER_RESPONSE_SEAL_KEY). Ported from Table Derby `partner/retained.ts`. */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'quizball-retained', 'partner-init-response', 32));
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  open(sealed: string): string | null {
    try {
      const raw = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
