# Dynamic OpenAPI Server URLs

## Issue Description

**Severity**: 🟡 Medium (Developer experience)
**File**: `src/http/openapi/registry.ts:1310-1312`
**Status**: ✅ Fixed

### Problem

The OpenAPI document hardcoded server URLs to `http://localhost:8001`:

```typescript
// BEFORE (hardcoded):
servers: [
  { url: 'http://localhost:8001', description: 'Local development' },
],
```

**Issues**:
1. ❌ Only works for localhost
2. ❌ Swagger UI "Try it out" breaks in staging/production
3. ❌ Generated API clients get wrong base URL
4. ❌ Not useful for frontend/mobile developers in deployed environments
5. ❌ Manual updates needed when deploying

---

## Fix

Made OpenAPI servers dynamic based on environment configuration.

### 1. Added Config Variable

**File**: `src/core/config.ts:41`

```typescript
// API Server URL (for OpenAPI documentation)
API_BASE_URL: z.string().url().optional(),
```

### 2. Dynamic Server Builder

**File**: `src/http/openapi/registry.ts:1305-1330`

```typescript
/**
 * Build OpenAPI servers array based on environment configuration.
 * Supports multiple environments (local, staging, production).
 */
function buildOpenApiServers(): Array<{ url: string; description: string }> {
  const servers: Array<{ url: string; description: string }> = [];

  // Add environment-specific URL if provided (e.g., staging/production)
  if (config.API_BASE_URL) {
    const envDescriptions: Record<string, string> = {
      local: 'Development Server',
      staging: 'Staging Server',
      prod: 'Production Server',
    };

    servers.push({
      url: config.API_BASE_URL,
      description: envDescriptions[config.NODE_ENV] || 'API Server',
    });
  }

  // Always include localhost for local development
  // Useful for developers even in staging/prod environments
  servers.push({
    url: `http://localhost:${config.PORT}`,
    description: 'Local development',
  });

  return servers;
}
```

### 3. Updated Document Generator

```typescript
export function generateOpenApiDocument() {
  return generator.generateDocument({
    // ...
    servers: buildOpenApiServers(), // ✅ Dynamic
  });
}
```

---

## Usage Examples

### Local Development (Default)

**No env vars needed** - uses PORT from config:

```bash
# .env
PORT=8001
```

**OpenAPI Output**:
```json
{
  "servers": [
    {
      "url": "http://localhost:8001",
      "description": "Local development"
    }
  ]
}
```

### Staging Environment

```bash
# .env or environment variables
NODE_ENV=staging
PORT=8000
API_BASE_URL=https://api-staging.quizball.app
DOCS_USERNAME=admin
DOCS_PASSWORD=secure-password
```

**OpenAPI Output**:
```json
{
  "servers": [
    {
      "url": "https://api-staging.quizball.app",
      "description": "Staging Server"
    },
    {
      "url": "http://localhost:8000",
      "description": "Local development"
    }
  ]
}
```

**Swagger UI**:
- Developers can test against staging server
- Or test locally if running the API

### Production Environment

```bash
# .env or environment variables
NODE_ENV=prod
PORT=8000
API_BASE_URL=https://api.quizball.app
DOCS_ENABLED=false  # Typically disabled in prod
```

**OpenAPI Output**:
```json
{
  "servers": [
    {
      "url": "https://api.quizball.app",
      "description": "Production Server"
    },
    {
      "url": "http://localhost:8000",
      "description": "Local development"
    }
  ]
}
```

---

## Benefits

| Aspect | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Local dev** | Hardcoded port | Uses `config.PORT` | ✅ Always correct |
| **Staging** | Not supported | Auto-configured | ✅ Swagger works |
| **Production** | Not supported | Auto-configured | ✅ API docs accurate |
| **API clients** | Wrong base URL | Correct URL | ✅ Auto-configured |
| **Maintenance** | Manual updates | Zero maintenance | ✅ Self-updating |

---

## Test Coverage

**File**: `tests/openapi/server-urls.test.ts`

**Test cases** (5):
1. ✅ Includes localhost with PORT from config
2. ✅ Includes API_BASE_URL when provided
3. ✅ Uses production description for prod environment
4. ✅ Only includes localhost when no API_BASE_URL
5. ✅ Uses Development Server description for local with API_BASE_URL

```bash
npm test -- tests/openapi/server-urls.test.ts
# ✅ 5/5 tests passing
```

---

## Backwards Compatibility

✅ **Fully backwards compatible**

- No env vars required (defaults to localhost)
- Existing deployments work without changes
- Can add `API_BASE_URL` later when needed

---

## Generated Client Benefits

When generating API clients (TypeScript, Python, etc.) from OpenAPI spec:

**Before**:
```typescript
// Generated client always uses localhost
const client = new QuizBallAPI({ baseUrl: 'http://localhost:8001' });
```

**After**:
```typescript
// Generated client gets correct URL for environment
const client = new QuizBallAPI({
  baseUrl: 'https://api.quizball.app' // ✅ Production URL
});
```

---

## Swagger UI Experience

### Before
- ❌ "Try it out" only works on localhost
- ❌ Breaks when docs deployed to staging/prod
- ❌ Developers can't test real API

### After
- ✅ "Try it out" works in all environments
- ✅ Can choose between staging/prod/local
- ✅ Interactive testing always available

**Example dropdown in Swagger UI**:
```
Servers:
▼ https://api-staging.quizball.app - Staging Server
  http://localhost:8001 - Local development
```

---

## Related Issues

This fix is part of:
- **Phase 6**: Post-implementation review fixes
- **Issue #32**: Dynamic OpenAPI server URLs

---

## Complete Fix History

### Phase 1-6: Previous fixes
[See previous documentation]

### Phase 6: Post-Implementation Review (continued)
30. Array ordering in `findDuplicateGroups` SQL ✅
31. getByIds returns Map instead of array ✅
32. **Dynamic OpenAPI server URLs** ✅ (this document)

**Total Issues Fixed: 28**
**Total Tests: 43 questions + 5 OpenAPI + 17 i18n = 65 (all passing)**
**TypeScript Compilation: ✅ PASSING**
**Ready for PR: ✅ YES**
