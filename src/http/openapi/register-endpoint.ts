import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { AnyZodObject, ZodEffects, ZodTypeAny } from 'zod';

type RouteParameter = AnyZodObject | ZodEffects<AnyZodObject, unknown, unknown>;

interface EndpointResponse {
  description: string;
  /** Omit `schema` for 204 No Content responses. */
  schema?: ZodTypeAny;
  /** Response media type for `schema`. Defaults to `application/json`. */
  mediaType?: string;
}

export interface EndpointSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  security?: RouteConfig['security'];
  body?: ZodTypeAny;
  query?: RouteParameter;
  pathParams?: RouteParameter;
  responses: Record<number, EndpointResponse>;
}

/**
 * Thin wrapper around `OpenAPIRegistry.registerPath` that collapses the
 * ~30-line `request.body.content[...].schema` and per-status response
 * boilerplate into a flat config object.
 *
 * The output is identical to a hand-written `registerPath` call — adding or
 * removing this helper does not change the generated OpenAPI document.
 */
export function registerEndpoint(
  registry: OpenAPIRegistry,
  spec: EndpointSpec
): void {
  const request: NonNullable<RouteConfig['request']> = {};
  if (spec.body) {
    request.body = {
      required: true,
      content: { 'application/json': { schema: spec.body } },
    };
  }
  if (spec.query) request.query = spec.query;
  if (spec.pathParams) request.params = spec.pathParams;

  const responses: RouteConfig['responses'] = {};
  for (const [code, { description, schema, mediaType }] of Object.entries(spec.responses)) {
    responses[Number(code)] = schema
      ? { description, content: { [mediaType ?? 'application/json']: { schema } } }
      : { description };
  }

  registry.registerPath({
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    tags: spec.tags,
    security: spec.security,
    request: Object.keys(request).length > 0 ? request : undefined,
    responses,
  });
}
