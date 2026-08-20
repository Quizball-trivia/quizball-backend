import { generateOpenApiDocument } from '../src/http/openapi/registry.js';

process.stdout.write(`${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`);
