import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '../../src/http/openapi/registry.js';

describe('CMS OpenAPI security contract', () => {
  const spec = generateOpenApiDocument();

  it.each([
    '/api/v1/questions',
    '/api/v1/questions/{id}',
    '/api/v1/categories/{id}/dependencies',
  ])('marks GET %s as bearer-authenticated', (path) => {
    const operation = spec.paths?.[path]?.get;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.responses).toHaveProperty('401');
    if (path.endsWith('/dependencies')) {
      expect(operation?.responses).toHaveProperty('403');
    }
  });

  it('accepts short search terms while retaining the 200-character ceiling', () => {
    const operation = spec.paths?.['/api/v1/questions']?.get;
    const search = operation?.parameters?.find(
      (parameter) => 'name' in parameter && parameter.name === 'search'
    );

    expect(search).toMatchObject({
      in: 'query',
      schema: expect.objectContaining({ maxLength: 200 }),
    });
    expect('schema' in (search ?? {}) && search?.schema).not.toHaveProperty('minLength');
  });
});
