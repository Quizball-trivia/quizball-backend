import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', fileParallelism: false,
  include: ['tests/mobile-push/*.test.ts'], setupFiles: ['tests/mobile-push/setup.ts'] } });
