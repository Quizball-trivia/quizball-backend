/**
 * Test setup file.
 * This file is loaded before tests run.
 */

// Set test environment
process.env.NODE_ENV = 'local';
process.env.PORT = '8000';
process.env.LOG_LEVEL = 'silent'; // Suppress logs during tests
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
