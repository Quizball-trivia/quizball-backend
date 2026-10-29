/** Supavisor can close a new connection before its first query is sent. */
export function isPoolAuthenticationProtocolError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === '08P01' && typeof candidate.message === 'string'
    && candidate.message.includes('(EAUTHPROTOCOL)')
    && candidate.message.includes('during authentication');
}

/** Retry a fresh read once; never replay writes or a failed transaction here. */
export async function readAfterPoolAuthenticationFailure<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isPoolAuthenticationProtocolError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    return read();
  }
}
