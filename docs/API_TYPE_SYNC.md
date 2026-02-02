# API Type Synchronization Guide

This document explains how to keep TypeScript types synchronized between the backend API and frontend applications (CMS, Web App).

## Overview

```
┌─────────────────┐     OpenAPI Spec      ┌─────────────────┐
│  Backend Node   │ ──────────────────►   │  Frontend Apps  │
│  (Zod Schemas)  │    /openapi.json      │  (TypeScript)   │
└─────────────────┘                       └─────────────────┘
        │                                         │
        ▼                                         ▼
   zod-to-openapi                         openapi-typescript
   (generates spec)                       (generates types)
                                                  │
                                                  ▼
                                            openapi-fetch
                                          (type-safe client)
```

## Quick Start

### After Making Backend API Changes

```bash
# 1. Backend: Ensure your Zod schemas are updated in src/http/openapi/registry.ts

# 2. Start the backend (if not running)
npm run dev

# 3. Frontend (CMS): Regenerate types
cd ../cms
npm run api:sync:local

# 4. Frontend: TypeScript will now catch any mismatches
npm run typecheck
```

### One-liner (from CMS directory)

```bash
npm run api:sync:local && npm run typecheck
```

## Commands Reference

### Backend Commands

| Command | Description |
|---------|-------------|
| `npm run api:export` | Export OpenAPI spec to stdout (for CI/CD) |
| `npm run api:export > openapi.json` | Save spec to file |

### Frontend Commands (CMS/Web)

| Command | Description |
|---------|-------------|
| `npm run api:sync:local` | Sync from local backend (localhost:8001) |
| `npm run api:sync:staging` | Sync from staging API |
| `npm run api:sync:prod` | Sync from production API |
| `npm run api:sync` | Sync from `$API_URL` env var |
| `npm run api:check` | CI: Verify types are up-to-date |
| `npm run typecheck` | Run TypeScript compiler |

## Type-Safe API Client Usage

The frontend uses `openapi-fetch` for fully type-safe API calls.

### Basic Usage

```typescript
import { api } from '@/lib/api';

// GET request - fully typed response
const { data, error } = await api.GET('/api/v1/categories/{id}', {
  params: { path: { id: 'category-uuid' } }
});

if (error) {
  console.error(error.code, error.message);
  return;
}

// data is fully typed as CategoryResponse
console.log(data.name, data.slug);
```

### With Query Parameters

```typescript
const { data } = await api.GET('/api/v1/questions', {
  params: {
    query: {
      category_id: 'uuid',
      status: 'published',  // TypeScript enforces: 'draft' | 'published' | 'archived'
      page: '1',
      limit: '20',
    }
  }
});
```

### POST/PUT Requests

```typescript
// Create - request body is fully typed
const { data, error } = await api.POST('/api/v1/categories', {
  body: {
    slug: 'sports',
    name: { en: 'Sports', ka: 'სპორტი' },
    is_active: true,
  }
});

// Update
const { data } = await api.PUT('/api/v1/categories/{id}', {
  params: { path: { id: 'uuid' } },
  body: {
    name: { en: 'Updated Name' },
  }
});
```

### DELETE Requests

```typescript
const { error } = await api.DELETE('/api/v1/categories/{id}', {
  params: {
    path: { id: 'uuid' },
    query: { cascade: 'true' }
  }
});
```

### Using with React Query

```typescript
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, type Category } from '@/lib/api';

// Query
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/categories');
      if (error) throw error;
      return data;
    },
  });
}

// Mutation
export function useCreateCategory() {
  return useMutation({
    mutationFn: async (body: { slug: string; name: { en: string } }) => {
      const { data, error } = await api.POST('/api/v1/categories', { body });
      if (error) throw error;
      return data;
    },
  });
}
```

## Using Generated Types Directly

```typescript
import type { components } from '@/types/api.generated';

// Schema types
type Category = components['schemas']['CategoryResponse'];
type Question = components['schemas']['QuestionResponse'];
type I18nField = components['schemas']['I18nField'];

// Or use the re-exported types from lib/api
import type { Category, Question, I18nField } from '@/lib/api';
```

## Workflow: When to Sync Types

### Sync Required

1. **Added a new endpoint** - Frontend needs the new path types
2. **Changed request/response schema** - Frontend types must match
3. **Renamed a field** - Frontend must use new field name
4. **Changed field type** - Frontend must handle new type
5. **Added/removed required fields** - Frontend validation affected

### No Sync Needed

1. Changed business logic (same inputs/outputs)
2. Updated internal implementation
3. Changed database queries (same API response)
4. Updated error messages (same error structure)

## CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/type-check.yml
name: Type Check

on:
  pull_request:
    paths:
      - 'src/**'
      - 'package.json'

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      # Verify types are in sync with production API
      - run: npm run api:check
        env:
          API_URL: ${{ secrets.PROD_API_URL }}

      - run: npm run typecheck
```

### Pre-commit Hook (Optional)

```bash
# .husky/pre-commit
npm run api:check
npm run typecheck
```

## Setting Up a New Frontend App

### 1. Install Dependencies

```bash
npm install openapi-fetch
npm install -D openapi-typescript
```

### 2. Add Scripts to package.json

```json
{
  "scripts": {
    "api:sync": "openapi-typescript ${API_URL:-http://localhost:8001}/openapi.json -o src/types/api.generated.ts",
    "api:sync:local": "openapi-typescript http://localhost:8001/openapi.json -o src/types/api.generated.ts",
    "api:check": "npm run api:sync && git diff --exit-code src/types/api.generated.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

### 3. Generate Initial Types

```bash
npm run api:sync:local
```

### 4. Create API Client

```typescript
// src/lib/api.ts
import createClient from 'openapi-fetch';
import type { paths } from '@/types/api.generated';

export const api = createClient<paths>({
  baseUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001',
});

// Add auth middleware
api.use({
  onRequest: ({ request }) => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return request;
  },
});
```

### 5. Use It!

```typescript
import { api } from '@/lib/api';

const { data, error } = await api.GET('/api/v1/users/me');
```

## Troubleshooting

### "Type 'X' is not assignable to type 'Y'"

Types are out of sync. Run:
```bash
npm run api:sync:local
```

### "Property 'X' does not exist"

A field was added/removed in the backend. Run:
```bash
npm run api:sync:local
```

### "Cannot fetch OpenAPI spec"

Backend not running. Start it first:
```bash
cd ../backend-node && npm run dev
```

### "CORS error when fetching spec"

The OpenAPI endpoint should allow CORS. Check backend CORS config.

## Architecture Benefits

1. **Single Source of Truth**: Zod schemas in backend define the contract
2. **Compile-Time Safety**: TypeScript catches API mismatches before runtime
3. **Zero Runtime Overhead**: Types are erased at compile time
4. **IDE Autocomplete**: Full IntelliSense for all API paths and parameters
5. **Refactoring Safety**: Rename a field → TypeScript shows all places to update
