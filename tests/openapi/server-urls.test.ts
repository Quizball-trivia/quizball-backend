import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateOpenApiDocument } from '../../src/http/openapi/registry.js';

describe('OpenAPI Server URLs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to reload config with new env vars
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  it('should include localhost with PORT from config', async () => {
    process.env.PORT = '8001';

    const { generateOpenApiDocument } = await import('../../src/http/openapi/registry.js');
    const doc = generateOpenApiDocument();

    const localhostServer = doc.servers?.find((s) => s.url.includes('localhost'));
    expect(localhostServer).toBeDefined();
    expect(localhostServer?.url).toBe('http://localhost:8001');
    expect(localhostServer?.description).toBe('Local development');
  });

  it('should include API_BASE_URL when provided', async () => {
    process.env.PORT = '8001';
    process.env.NODE_ENV = 'staging';
    process.env.API_BASE_URL = 'https://api-staging.quizball.app';
    process.env.DOCS_ENABLED = 'false'; // Disable docs to avoid auth requirement
    process.env.DOCS_USERNAME = 'test';
    process.env.DOCS_PASSWORD = 'test';

    const { generateOpenApiDocument } = await import('../../src/http/openapi/registry.js');
    const doc = generateOpenApiDocument();

    expect(doc.servers).toHaveLength(2);

    const stagingServer = doc.servers?.find((s) => s.url.includes('staging'));
    expect(stagingServer).toBeDefined();
    expect(stagingServer?.url).toBe('https://api-staging.quizball.app');
    expect(stagingServer?.description).toBe('Staging Server');

    const localhostServer = doc.servers?.find((s) => s.url.includes('localhost'));
    expect(localhostServer).toBeDefined();
  });

  it('should use production description for prod environment', async () => {
    process.env.PORT = '8000';
    process.env.NODE_ENV = 'prod';
    process.env.API_BASE_URL = 'https://api.quizball.app';
    process.env.DOCS_ENABLED = 'false';
    process.env.DOCS_USERNAME = 'test';
    process.env.DOCS_PASSWORD = 'test';

    const { generateOpenApiDocument } = await import('../../src/http/openapi/registry.js');
    const doc = generateOpenApiDocument();

    const prodServer = doc.servers?.find((s) => s.url.includes('api.quizball.app'));
    expect(prodServer).toBeDefined();
    expect(prodServer?.description).toBe('Production Server');
  });

  it('should only include localhost when no API_BASE_URL', async () => {
    process.env.PORT = '8001';
    process.env.NODE_ENV = 'local';
    delete process.env.API_BASE_URL;

    const { generateOpenApiDocument } = await import('../../src/http/openapi/registry.js');
    const doc = generateOpenApiDocument();

    expect(doc.servers).toHaveLength(1);
    expect(doc.servers?.[0].url).toBe('http://localhost:8001');
  });

  it('should use Development Server description for local environment with API_BASE_URL', async () => {
    process.env.PORT = '8001';
    process.env.NODE_ENV = 'local';
    process.env.API_BASE_URL = 'http://localhost:3000';

    const { generateOpenApiDocument } = await import('../../src/http/openapi/registry.js');
    const doc = generateOpenApiDocument();

    const localServer = doc.servers?.find((s) => s.url === 'http://localhost:3000');
    expect(localServer?.description).toBe('Development Server');
  });
});
