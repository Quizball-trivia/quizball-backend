# Backend Node Code Quality Fixes

## Overview

Comprehensive fix plan for 17 issues identified in code review.
**Verified Status**: 1 of 17 fully fixed (Issue #1 Authorization)
**Scope**: Implement ALL issues including previously deferred items

---

## CRITICAL PRIORITY (Security & Data Integrity)

### Issue #2: Open Redirect in OAuth Flow

**Status Verified**: `auth.schemas.ts:26,38` - No domain validation on `redirect_to`
**Risk**: HIGH SECURITY - Enables phishing attacks
**Files**: `src/modules/auth/auth.schemas.ts`, `src/core/constants.ts` (new)

**Fix**:
```typescript
// src/core/constants.ts - ADD
export const ALLOWED_REDIRECT_DOMAINS = [
  'localhost:3000',
  'localhost:8000',
  'quizball.app',
  'www.quizball.app',
];

// src/modules/auth/auth.schemas.ts - MODIFY
import { ALLOWED_REDIRECT_DOMAINS } from '../../core/constants.js';

const redirectUrlSchema = z.string().url().refine((url) => {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_DOMAINS.includes(parsed.host);
  } catch {
    return false;
  }
}, 'Redirect URL must be to an allowed domain');

// Apply to both schemas:
export const socialLoginSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github']),
  redirect_to: redirectUrlSchema,
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  redirect_to: redirectUrlSchema.optional(),
});
```

---

### Issue #4: Missing Transactions for Related Entity Creation

**Status Verified**:
- `users.service.ts:44-54` - Creates user, then identity separately
- `questions.service.ts:56-60` - Creates question, then payload separately

**Risk**: CRITICAL DATA INTEGRITY - Orphaned records on partial failure
**Architectural Constraint**: Services don't import `sql` - fix must be in repo layer

**Fix for users.repo.ts** (add new transactional method):
```typescript
// src/modules/users/users.repo.ts - ADD METHOD
async createWithIdentity(userData: CreateUserData, identityData: CreateIdentityData): Promise<User> {
  return sql.begin(async (tx) => {
    const [user] = await tx<User[]>`
      INSERT INTO users (email) VALUES (${userData.email ?? null})
      RETURNING *
    `;
    await tx`
      INSERT INTO user_identities (user_id, provider, subject, email)
      VALUES (${user.id}, ${identityData.provider}, ${identityData.subject}, ${identityData.email ?? null})
    `;
    return user;
  });
}

// src/modules/users/users.service.ts - UPDATE to call new repo method
const newUser = await usersRepo.createWithIdentity(
  { email: identity.email },
  { provider: identity.provider, subject: identity.subject, email: identity.email }
);
// Remove separate identitiesRepo.create() call
```

**Fix for questions.repo.ts** (add transactional create):
```typescript
// src/modules/questions/questions.repo.ts - ADD METHOD
async createWithPayload(data: CreateQuestionData, payload?: Json): Promise<QuestionWithPayload> {
  return sql.begin(async (tx) => {
    const [question] = await tx<Question[]>`
      INSERT INTO questions (category_id, type, difficulty, prompt, status, explanation)
      VALUES (${data.categoryId}, ${data.type}, ${data.difficulty}, ${data.prompt},
              ${data.status ?? 'draft'}, ${data.explanation ?? null})
      RETURNING *
    `;

    let questionPayload = null;
    if (payload) {
      const [p] = await tx<{ payload: Json }[]>`
        INSERT INTO question_payloads (question_id, payload)
        VALUES (${question.id}, ${payload})
        RETURNING payload
      `;
      questionPayload = p.payload;
    }

    return { ...question, payload: questionPayload };
  });
}

// src/modules/questions/questions.service.ts - UPDATE create method
const question = await questionsRepo.createWithPayload(data, data.payload);
// Remove separate createPayload call
```

---

## HIGH PRIORITY (Performance & Scalability)

### Issue #6: Database Call on Every Authenticated Request

**Status Verified**: `auth.ts:57` calls `usersService.getOrCreateFromIdentity()` on every request
**Risk**: PERFORMANCE BOTTLENECK - Every auth request hits DB

**Decision**: Use simple Map cache (no new dependency)

```typescript
// src/modules/users/user-cache.ts - NEW FILE
import type { User } from '../../db/types.js';

const cache = new Map<string, { user: User; expiresAt: number }>();
const TTL_MS = 60 * 1000; // 60 seconds

export function getCacheKey(provider: string, subject: string): string {
  return `${provider}:${subject}`;
}

export function getCachedUser(provider: string, subject: string): User | null {
  const key = getCacheKey(provider, subject);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.user;
}

export function setCachedUser(provider: string, subject: string, user: User): void {
  const key = getCacheKey(provider, subject);
  cache.set(key, { user, expiresAt: Date.now() + TTL_MS });
}

export function invalidateUser(provider: string, subject: string): void {
  cache.delete(getCacheKey(provider, subject));
}
```

**Service update**:
```typescript
// users.service.ts
import { getCachedUser, setCachedUser } from './user-cache.js';

async getOrCreateFromIdentity(identity: AuthIdentity): Promise<User> {
  const cached = getCachedUser(identity.provider, identity.subject);
  if (cached) return cached;

  // ... existing logic ...

  setCachedUser(identity.provider, identity.subject, user);
  return user;
}
```

---

### Issue #5: Unbounded Categories List

**Status Verified**: `categories.repo.ts:30-59` - No pagination
**Risk**: PERFORMANCE - Could return thousands of records

**BREAKING API CHANGE**: Return type changes from `Category[]` to `{ data, total, page, limit, total_pages }`

**Files to modify**:
1. `src/modules/categories/categories.schemas.ts` - Add pagination params
2. `src/modules/categories/categories.repo.ts` - Add pagination with window function
3. `src/modules/categories/categories.service.ts` - Pass pagination params
4. `src/modules/categories/categories.controller.ts` - Extract pagination from query

**Fix**:
```typescript
// categories.schemas.ts
export const listCategoriesQuerySchema = z.object({
  parent_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// categories.repo.ts - Use COUNT(*) OVER() to avoid double query
async list(filter?: ListCategoriesFilter, page = 1, limit = 50): Promise<{ categories: Category[]; total: number }> {
  const offset = (page - 1) * limit;
  // ... filters ...

  const results = await sql<(Category & { total_count: string })[]>`
    SELECT *, COUNT(*) OVER() as total_count
    FROM categories
    WHERE 1=1 ${parentIdFilter} ${isActiveFilter}
    ORDER BY name->>'en' ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return {
    categories: results.map(({ total_count, ...c }) => c),
    total: results.length > 0 ? parseInt(results[0].total_count, 10) : 0,
  };
}

// categories.controller.ts - Update to return paginated response
async list(req: Request, res: Response): Promise<void> {
  const { parent_id, is_active, page, limit } = req.validated.query;
  const result = await categoriesService.list({ parentId: parent_id, isActive: is_active }, page, limit);
  res.json({
    data: result.categories,
    page,
    limit,
    total: result.total,
    total_pages: Math.ceil(result.total / limit),
  });
}
```

---

### Issue #3: N+1 Queries in Featured Categories Reorder

**Status Verified**: `featured-categories.repo.ts:184-195` - Uses transaction but N individual UPDATE queries

**Current**: Loop with N queries inside transaction
**Fix**: Single bulk UPDATE with validation

```typescript
// featured-categories.repo.ts - REPLACE reorder method
async reorder(items: ReorderItem[]): Promise<void> {
  if (items.length === 0) return;

  const ids = items.map(i => i.id);
  const sortOrders = items.map(i => i.sortOrder);

  await sql`
    UPDATE featured_categories fc
    SET sort_order = v.sort_order, updated_at = NOW()
    FROM (
      SELECT unnest(${ids}::uuid[]) as id,
             unnest(${sortOrders}::int[]) as sort_order
    ) as v
    WHERE fc.id = v.id
  `;
}

// featured-categories.service.ts - Already validates with findMissingIds, keep existing validation
async reorder(items: ReorderItem[]): Promise<void> {
  if (items.length === 0) {
    throw new BadRequestError('No items to reorder');
  }
  // ADD: Limit check
  if (items.length > 100) {
    throw new BadRequestError('Cannot reorder more than 100 items at once');
  }

  const ids = items.map((i) => i.id);
  const missing = await featuredCategoriesRepo.findMissingIds(ids);
  if (missing.length > 0) {
    throw new NotFoundError(`Featured categories not found: ${missing.join(', ')}`);
  }
  await featuredCategoriesRepo.reorder(items);
}
```

---

## MEDIUM PRIORITY

### Issue #7: CORS Origin Validation

**Status**: Single string origin, not multi-origin validation
**Files**: `src/core/config.ts`, `src/app.ts`

```typescript
// config.ts - Rename to plural
CORS_ORIGINS: z.string().default('http://localhost:3000'),

// app.ts
const allowedOrigins = config.CORS_ORIGINS.split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
```

---

### Issue #8: Rate Limiting on All API Routes

**Status**: Only on `/api/v1/auth`
**File**: `src/app.ts`

```typescript
// Add general API limiter before auth limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', details: null, request_id: null },
});

app.use('/api/v1', apiLimiter);
app.use('/api/v1/auth', authLimiter); // Stricter, applied after general

Start with 300/min general, 50/min auth, monitor logs, then tighten if needed.
```

---

### Issue #10: Duplicate COUNT Query

**Status**: `questions.repo.ts:54-65` - Separate COUNT query
**Fix**: Use `COUNT(*) OVER()` (same pattern as Issue #5)

---

### Issue #11: Missing Database Indexes

**Already exist** (from migrations):
- `categories.slug` - UNIQUE constraint (implicit index)
- `featured_categories.category_id` - UNIQUE constraint (implicit index)
- `user_identities(provider, subject)` - UNIQUE constraint (implicit index)

**Only missing**: `questions(status)` for filtering queries

**File**: `supabase/migrations/YYYYMMDDHHMMSS_add_questions_status_index.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
```

---

### Issue #9: Shared Schemas

**Problem**: Duplicate schema patterns across modules
**Fix**: Create shared pagination and response schemas

```typescript
// src/http/schemas/shared.ts - NEW FILE
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: z.array(dataSchema),
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    total_pages: z.number(),
  });
```

---

### Issue #12: JWT Config Validation

**Problem**: JWT secret/URL not validated at startup
**File**: `src/core/config.ts`

```typescript
// Add to configSchema
SUPABASE_JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
```

---

## LOW PRIORITY

### Issue #13: Remove Unused Code
Remove `count()` method from `featured-categories.repo.ts:200-205`

### Issue #14: Consolidate Express Types

**Problem**: Express request extensions scattered across files
**File**: `src/types/express.d.ts` - NEW FILE

```typescript
import type { User } from '../db/types.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      validated: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
```

Update `tsconfig.json` to include this file in compilation.

### Issue #15: Remove Redundant Header Setting
Remove duplicate `X-Request-ID` from `error-handler.ts:25-27,81-83`

### Issue #16: Disable Swagger in Production

**File**: `src/http/routes/index.ts`
**Note**: Environment uses `'prod'` not `'production'` (see `config.ts`)

```typescript
import { config } from '../../core/config.js';

// Conditionally enable swagger (only in non-prod)
if (config.NODE_ENV !== 'prod') {
  router.use(swaggerRoutes);
}
```

### Issue #17: Reset Token in Header

**BREAKING CHANGE** - Header only, fix any client code

```typescript
// auth.schemas.ts - Remove access_token from body
export const resetPasswordSchema = z.object({
  new_password: z.string().min(8),
});

// auth.controller.ts - Only accept Authorization header
async resetPassword(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing Authorization header');
  }
  const accessToken = authHeader.substring(7);
  const { new_password } = req.validated.body as { new_password: string };
  await authService.resetPassword(accessToken, new_password);
  res.status(200).json({ message: 'Password updated successfully' });
}
```

**CMS**: Check if reset password is implemented. If so, update to use Authorization header.

---

## Execution Order

| Phase | Issues | Notes |
|-------|--------|-------|
| 1. Security | #2 (Open Redirect) | No breaking changes |
| 2. Data Integrity | #4 (Transactions) | Repo-level changes |
| 3. Performance | #6 (Caching) | Map cache, no dependency |
| 4. Performance | #3 (N+1), #5 (Pagination) | #5 is breaking API |
| 5. Medium | #7, #8, #9, #10, #11, #12 | Infrastructure |
| 6. Cleanup | #13, #14, #15, #16, #17 | Code quality |

---

## Decisions Made

1. **Issue #6 Caching**: Use simple Map cache (no new dependency)
2. **Issue #5 Pagination**: Break the API, update both backend and CMS
3. **Issue #17 Token**: Only accept Authorization header, fix any client code
4. **Issue #11 Indexes**: Only add `questions(status)` - others already exist
5. **Issue #16 Swagger**: Check `NODE_ENV !== 'prod'` (not 'production')
6. **Deferred items**: Implement ALL (#9, #12, #14)

---

## CMS Impact (Required Changes)

### Categories Pagination (Issue #5)

Backend changes response from `Category[]` to `{ data, total, page, limit, total_pages }`.

**Files to update in CMS**:

1. `cms/src/services/categories.service.ts` (line 11-12):
```typescript
// BEFORE
async list(params?: ListCategoriesParams): Promise<Category[]> {
  return apiClient.get<Category[]>('/categories', params);
}

// AFTER - Extract data from paginated response
interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

async list(params?: ListCategoriesParams): Promise<Category[]> {
  const response = await apiClient.get<PaginatedResponse<Category>>('/categories', params);
  return response.data;
}
```

2. `cms/src/hooks/use-categories.ts` - No change needed (service handles extraction)

3. `cms/src/types/category.ts` - Add ListCategoriesParams with page/limit if needed for future pagination UI

### Reset Password Token (Issue #17)

CMS currently doesn't implement reset password (`auth.service.ts` only has login/logout/getMe).
**No CMS changes required** - backend change is safe.

### After Backend Changes

Run `npm run db:types` in backend to regenerate types, then update CMS generated types if using OpenAPI codegen.

---

## Verification

1. `npm run lint` - Type check passes
2. `npm test` - All tests pass
3. **Security**: Test OAuth with `redirect_to=https://evil.com` - should reject
4. **Transactions**: Simulate payload create failure - no orphaned question
5. **Cache**: Log cache hits in auth middleware
6. **Pagination**: Categories returns `{ data, total, page, limit }`

---

## Status Tracking

| # | Issue | Priority | Status |
|---|-------|----------|--------|
| 1 | Authorization | High | DONE |
| 2 | Open Redirect | Critical | TODO |
| 3 | N+1 Reorder | High | TODO (bulk UPDATE) |
| 4 | Transactions | Critical | TODO |
| 5 | Unbounded Categories | High | TODO (+ CMS + tests) |
| 6 | Auth Caching | High | TODO (Map cache) |
| 7 | CORS Validation | Medium | TODO |
| 8 | Rate Limiting | Medium | TODO |
| 9 | Shared Schemas | Medium | TODO |
| 10 | COUNT Query | Medium | TODO |
| 11 | DB Indexes | Medium | TODO (only questions.status) |
| 12 | JWT Config | Medium | TODO |
| 13 | Unused Code | Low | TODO |
| 14 | Express Types | Low | TODO |
| 15 | Redundant Header | Low | TODO |
| 16 | Swagger Prod | Low | TODO (check 'prod') |
| 17 | Token in Header | Low | TODO (header only) |
