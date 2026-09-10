/**
 * Test setup file.
 * This file is loaded before tests run.
 */

// Set test environment
process.env.NODE_ENV = 'local';
process.env.PORT = '8000';
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent'; // Suppress logs during tests
process.env.CORS_ORIGINS = 'http://localhost:3000';
const gridTestDatabase = process.env.FOOTBALL_GRID_TEST_DATABASE_URL;
if (gridTestDatabase && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(gridTestDatabase).hostname)) {
  throw new Error('Grid integration tests require a local database');
}
process.env.DATABASE_URL = gridTestDatabase ?? 'postgresql://test:test@localhost:5432/test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
