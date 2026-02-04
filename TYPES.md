# Backend Types Guide

This backend is the **source of truth** for all API types. Frontend apps generate their types from the OpenAPI spec served by this backend.

## How Types Flow

```
Zod Schemas (backend)
       ↓
OpenAPI Spec (/openapi.json)
       ↓
openapi-typescript (frontend)
       ↓
TypeScript Types (frontend)
```

## Defining API Types

All API schemas are defined in `src/http/openapi/registry.ts` using Zod with OpenAPI extensions.

### Adding a New Schema

```typescript
// 1. Define the Zod schema with .openapi() metadata
const myResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    created_at: z.string().datetime(),
  })
  .openapi('MyResponse');

// 2. Register it
registry.register('MyResponse', myResponseSchema);
```

### Adding a New Endpoint

```typescript
registry.registerPath({
  method: 'get',
  path: '/api/v1/my-resource/{id}',
  summary: 'Get my resource',
  tags: ['MyResource'],
  security: [{ bearerAuth: [] }],  // If auth required
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      include_details: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Resource found',
      content: { 'application/json': { schema: myResponseSchema } },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});
```

## Commands

```bash
# Export OpenAPI spec to stdout
npm run api:export

# Export to file
npm run api:export > openapi.json

# View spec in browser (server must be running)
open http://localhost:8001/docs
```

## After Making API Changes

1. Update Zod schemas in `src/http/openapi/registry.ts`
2. Restart dev server if needed: `npm run dev`
3. Notify frontend devs to run `npm run api:sync:local`

## Verifying Types Are Correct

### 1. Check OpenAPI spec is valid

```bash
# Start server and check spec loads
npm run dev
curl http://localhost:8001/openapi.json | head -50
```

### 2. Cross-check with frontends

```bash
# In CMS
cd ../cms
npm run api:sync:local
npm run typecheck

# In Web
cd ../web
npm run api:sync:local
npm run typecheck
```

If TypeScript passes in all projects, types are in sync.

## Common Patterns

### I18n Field (Multi-language)

```typescript
const i18nFieldSchema = z.record(z.string()).openapi('I18nField');
// Results in: { [key: string]: string } e.g., { en: "Hello", ka: "გამარჯობა" }
```

### Paginated Response

```typescript
const paginatedSchema = z
  .object({
    data: z.array(itemSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  })
  .openapi('PaginatedItems');
```

### Enum Fields

```typescript
const statusSchema = z.enum(['draft', 'published', 'archived']);
// Frontend gets: 'draft' | 'published' | 'archived'
```

### Nullable vs Optional

```typescript
// Nullable: field exists but can be null
z.string().nullable()  // string | null

// Optional: field may not exist
z.string().optional()  // string | undefined

// Both: may not exist, or exist as null
z.string().nullable().optional()  // string | null | undefined
```

## Auth Transport (Browser Clients)

Browser clients authenticate via **httpOnly cookies** (access + refresh).  
Bearer `Authorization` headers are still supported for non-browser clients.

Implications:
- CORS must allow credentials.
- Frontend requests must set `credentials: "include"`.

## Troubleshooting

### Frontend says field doesn't exist

1. Check the schema in `registry.ts` includes the field
2. Restart backend: `npm run dev`
3. Frontend: `npm run api:sync:local`

### Type mismatch between backend and frontend

1. Compare the Zod schema with generated types
2. Check if you're using the correct response schema
3. Ensure frontend ran `api:sync:local` recently

### OpenAPI spec not updating

1. Clear the cache by restarting the server
2. Check for TypeScript errors: `npm run lint`
