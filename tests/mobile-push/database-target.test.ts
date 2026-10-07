import { expect, it } from 'vitest';
import { isolatedPushTestDatabaseUrl } from './database-target.js';
it.each([
  'postgresql://user@127.0.0.1:5432/quizball_push_test_20261007',
  'postgresql://postgres:postgres@127.0.0.1:55439/quizball_push_test_20261007',
])('accepts only the explicitly isolated local/CI push database', value => {
  expect(isolatedPushTestDatabaseUrl(value)).toBe(value);
});
it.each([
  'postgresql://user@db.example.com:5432/quizball_push_test_20261007',
  'postgresql://user@127.0.0.1:5432/postgres',
  'postgresql://user@127.0.0.1:5432/test',
  'https://127.0.0.1/quizball_push_test_20261007',
  'postgresql://user@127.0.0.1:5432/quizball_push_test_20261007?host=db.example.com',
  'postgresql://user@127.0.0.1:5432/quizball_push_test_20261007#other',
])('rejects unsafe test database targets before connecting', value => {
  expect(() => isolatedPushTestDatabaseUrl(value)).toThrow('dedicated loopback-only');
});
