/**
 * Test setup file.
 * This file is loaded before tests run.
 */

// Set test environment
process.env.NODE_ENV = 'local';
process.env.PORT = '8000';
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent'; // Suppress logs during tests
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_JWT_SECRET = 'test-campaign-rating-secret-1234567890';
delete process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL;
delete process.env.GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT_EMAIL;
delete process.env.GOOGLE_SEARCH_CONSOLE_PRIVATE_KEY;
