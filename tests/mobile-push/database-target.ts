export function isolatedPushTestDatabaseUrl(value: string): string {
  const target = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      target.hostname !== '127.0.0.1' || target.pathname !== '/quizball_push_test_20261007' ||
      target.search || target.hash) {
    throw new Error('Push tests require the dedicated loopback-only test database');
  }
  return value;
}
