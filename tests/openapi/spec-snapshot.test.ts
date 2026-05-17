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
/**
 * Returns a stable JSON-stringified copy of the OpenAPI doc:
 *   - `servers` removed (depends on PORT / API_BASE_URL env)
 *   - `components.schemas` and `paths` re-emitted in sorted-key order
 *     so module migration that registers schemas in a different sequence
 *     doesn't fail the snapshot — only true semantic drift does.
 */
function canonicalize(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return JSON.stringify(spec);
  const { servers, ...rest } = spec as Record<string, unknown>;
  void servers;
  return JSON.stringify(rest, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
      return sorted;
    }
    return value;
  }, 2);
}

describe('OpenAPI spec', () => {
  it('matches the pre-refactor baseline (canonicalized: sorted keys, excluding env-dependent servers)', () => {
    const doc = generateOpenApiDocument();
    expect(canonicalize(doc)).toEqual(canonicalize(baseline));
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
