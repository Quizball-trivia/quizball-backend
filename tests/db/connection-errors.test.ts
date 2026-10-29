import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPoolAuthenticationProtocolError, readAfterPoolAuthenticationFailure } from '../../src/db/connection-errors.js';

const poolError = () => Object.assign(new Error('(EAUTHPROTOCOL) protocol violation during authentication'), { code: '08P01' });
afterEach(() => vi.useRealTimers());
describe('pool authentication read recovery', () => {
  it('repeats a fresh read once after the observed handshake failure', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(poolError()).mockResolvedValueOnce(['notice']);
    const pending = readAfterPoolAuthenticationFailure(read);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(['notice']);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('bounds persistent failures and preserves the final error', async () => {
    vi.useFakeTimers();
    const error = poolError();
    const read = vi.fn().mockRejectedValue(error);
    const pending = expect(readAfterPoolAuthenticationFailure(read)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each([
    Object.assign(new Error('protocol violation while executing a query'), { code: '08P01' }),
    Object.assign(new Error('bad password'), { code: '28P01' }),
    Object.assign(new Error('unique violation'), { code: '23505' }),
    Object.assign(new Error('pool overloaded'), { code: 'DB_OVERLOADED' }),
  ])('does not retry unrelated errors', async error => {
    const read = vi.fn().mockRejectedValue(error);
    expect(isPoolAuthenticationProtocolError(error)).toBe(false);
    await expect(readAfterPoolAuthenticationFailure(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
