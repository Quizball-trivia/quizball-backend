#!/usr/bin/env npx tsx
/**
 * Export OpenAPI spec to a JSON file without running the server.
 *
 * Usage:
 *   npm run api:export              # Outputs to stdout
 *   npm run api:export > openapi.json   # Save to file
 *
 * This is useful for:
 *   - CI/CD pipelines that need the spec without starting the server
 *   - Generating frontend types from a known spec version
 *   - Versioning the API spec in git
 */

import { generateOpenApiDocument } from '../src/http/openapi/index.js';

const spec = generateOpenApiDocument();

console.log(JSON.stringify(spec, null, 2));
