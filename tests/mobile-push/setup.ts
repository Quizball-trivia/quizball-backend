// Deliberately separate from the game's shared test database. Never use a
// remotely configured DATABASE_URL or mutate a production/staging user.
import { isolatedPushTestDatabaseUrl } from './database-target.js';
process.env.NODE_ENV = 'local';
process.env.DATABASE_URL = isolatedPushTestDatabaseUrl(process.env.PUSH_TEST_DATABASE_URL ?? 'postgresql://user@127.0.0.1:5432/quizball_push_test_20261007');
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_JWT_SECRET = 'test-mobile-push-secret-1234567890';
process.env.LOG_LEVEL = 'silent';
process.env.PUSH_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PUSH_TOKEN_FINGERPRINT_KEY = 'b'.repeat(64);
process.env.PUSH_DELIVERY_ENABLED = 'true';
process.env.PUSH_EXPO_ACCESS_TOKEN = 'test-only-enhanced-push-token';
process.env.PUSH_TEST_USER_IDS = '11111111-1111-4111-8111-111111111111';
