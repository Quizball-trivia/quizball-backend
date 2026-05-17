import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '../../src/http/openapi/registry.js';
import baseline from './__fixtures__/openapi.baseline.json' with { type: 'json' };

/**
 * Drift guard for the OpenAPI registry refactor.
 *
 * The baseline fixture was captured before splitting registry.ts into
 * per-module *.openapi.ts files. Every commit during (and after) the refactor
 * must produce a byte-identical generated document.
 *
 * If this test fails:
 *   - Intentional spec change (new endpoint, schema bump)? Regenerate the
 *     baseline with: `npx tsx scripts/export-openapi.ts > tests/openapi/__fixtures__/openapi.baseline.json`
 *     and commit it in the same PR.
 *   - Otherwise, the refactor introduced drift — investigate before merging.
 */
function stripVolatile(spec: unknown): unknown {
  if (!spec || typeof spec !== 'object') return spec;
  // `servers` depends on PORT / API_BASE_URL env (see tests/openapi/server-urls.test.ts);
  // it's not part of the API contract the frontend types regenerate from.
  const { servers, ...rest } = spec as Record<string, unknown>;
  void servers;
  return rest;
}

describe('OpenAPI spec', () => {
  it('matches the pre-refactor baseline (byte-identical JSON output, excluding env-dependent servers)', () => {
    const doc = generateOpenApiDocument();
    expect(JSON.stringify(stripVolatile(doc), null, 2))
      .toEqual(JSON.stringify(stripVolatile(baseline), null, 2));
  });

  it('exposes the same path inventory', () => {
    const doc = generateOpenApiDocument();
    const paths = Object.keys(doc.paths ?? {}).sort();
    const baselinePaths = Object.keys((baseline as { paths?: Record<string, unknown> }).paths ?? {}).sort();
    expect(paths).toEqual(baselinePaths);
  });

  it('exposes the same schema inventory', () => {
    const doc = generateOpenApiDocument();
    const schemas = Object.keys(doc.components?.schemas ?? {}).sort();
    const baselineSchemas = Object.keys(
      (baseline as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}
    ).sort();
    expect(schemas).toEqual(baselineSchemas);
  });
});
