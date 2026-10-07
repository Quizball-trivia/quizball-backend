import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../../core/config.js';

export class PushTokenDecryptionError extends Error {}
function key(id = config.PUSH_TOKEN_ENCRYPTION_KEY_ID) {
  const previous = config.PUSH_TOKEN_DECRYPTION_KEYS ? JSON.parse(config.PUSH_TOKEN_DECRYPTION_KEYS) as Record<string,string> : {};
  const secret = id === config.PUSH_TOKEN_ENCRYPTION_KEY_ID ? config.PUSH_TOKEN_ENCRYPTION_KEY : previous[id];
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Push token encryption is not configured');
  return Buffer.from(secret, 'hex');
}
export function pushTokenFingerprint(token: string) {
  if (!config.PUSH_TOKEN_FINGERPRINT_KEY) throw new Error('Push fingerprint key is not configured');
  return createHmac('sha256', Buffer.from(config.PUSH_TOKEN_FINGERPRINT_KEY,'hex')).update(token).digest('hex');
}
export function pushFingerprintKeyIdentity() { return pushTokenFingerprint('quizball-push-fingerprint-key-v1'); }
export function encryptPushToken(token: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return config.PUSH_TOKEN_ENCRYPTION_KEY_ID + '.' + [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.');
}
export function decryptPushToken(encrypted: string) {
  try {
    const [id,...parts] = encrypted.split('.');
    if (parts.length !== 3) throw new Error();
    const [iv,tag,ciphertext] = parts.map(v=>Buffer.from(v,'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key(id), iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new PushTokenDecryptionError('Push token cannot be decrypted with the configured key versions'); }
}
