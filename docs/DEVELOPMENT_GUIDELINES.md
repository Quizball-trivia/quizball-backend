# Development Guidelines

This document outlines coding standards, patterns, and best practices for the QuizBall backend. Follow these guidelines when adding new features or modifying existing code.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Security](#security)
3. [Database](#database)
4. [API Design](#api-design)
5. [Error Handling](#error-handling)
6. [Validation](#validation)
7. [Testing](#testing)
8. [Code Organization](#code-organization)

---

## Architecture

### Layer Separation ✅

We follow a strict layered architecture:

```
Routes → Controllers → Services → Repositories/Providers
```

| Layer | Responsibility | Can Import From |
|-------|---------------|-----------------|
| **Routes** | Wire endpoints with middleware | Controllers, Middleware |
| **Controllers** | Translate HTTP ↔ Service calls | Services, Schemas |
| **Services** | Business logic | Repos, Providers, Other Services |
| **Repositories** | Database queries only | DB connection |
| **Providers** | External API integrations | External SDKs |

**DO:**
```typescript
// Controller - only handles HTTP concerns
async create(req: Request, res: Response): Promise<void> {
  const data = req.validated.body as CreateCategoryRequest;
  const category = await categoriesService.create(data);
  res.status(201).json(toCategoryResponse(category));
}

// Service - contains business logic
async create(data: CreateCategoryData): Promise<Category> {
  const existingSlug = await categoriesRepo.findBySlug(data.slug);
  if (existingSlug) {
    throw new ConflictError('Category with this slug already exists');
  }
  return categoriesRepo.create(data);
}
```

**DON'T:**
```typescript
// ❌ Don't put business logic in controllers
async create(req: Request, res: Response): Promise<void> {
  const existing = await categoriesRepo.findBySlug(req.body.slug);
  if (existing) {
    return res.status(409).json({ error: 'Exists' });
  }
  // ...
}

// ❌ Don't use Express types in services
async create(req: Request): Promise<Category> { ... }
```

### Dependency Direction

Dependencies flow inward: Routes → Controllers → Services → Repos

**Never import:**
- Routes from Controllers
- Controllers from Services
- Services from Repos
- HTTP types (`Request`, `Response`) in Services/Repos

---

## Security

### Authorization ✅

Always implement proper authorization, not just authentication.

**DO:**
```typescript
// Apply role-based middleware to protected routes
router.post(
  '/',
  authMiddleware,           // Verifies user is authenticated
  requireRole('admin'),     // Verifies user has permission
  validate({ body: schema }),
  controller.create
);
```

**DON'T:**
```typescript
// ❌ Authentication alone is not enough for mutations
router.post('/', authMiddleware, controller.create);
```

### Input Validation ✅

Validate ALL external input with Zod schemas.

**DO:**
```typescript
// Validate with length limits and patterns
export const createCategorySchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: i18nFieldSchema,
  description: i18nFieldSchema.nullable().optional(),
});

// Use validated data from middleware
const data = req.validated.body as CreateCategoryRequest;
```

**DON'T:**
```typescript
// ❌ Never use raw request data
const { slug, name } = req.body;

// ❌ Don't allow unbounded input
export const schema = z.object({
  name: z.record(z.string(), z.string()), // No limits!
});
```

### Redirect URL Validation ✅

Always validate redirect URLs against an allowlist.

**DO:**
```typescript
const ALLOWED_REDIRECT_DOMAINS = ['localhost:3000', 'quizball.app'];

export const socialLoginSchema = z.object({
  redirect_to: z.string().url().refine((url) => {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_DOMAINS.includes(parsed.host);
  }, 'Invalid redirect domain'),
});
```

**DON'T:**
```typescript
// ❌ Never accept arbitrary redirect URLs
redirect_to: z.string().url(),
```

### SQL Injection Prevention ✅

Always use parameterized queries via postgres.js tagged templates.

**DO:**
```typescript
// Parameters are automatically escaped
const categories = await sql<Category[]>`
  SELECT * FROM categories WHERE slug = ${slug}
`;

// Dynamic filters using sql fragments
const filter = status ? sql`AND status = ${status}` : sql``;
const questions = await sql`SELECT * FROM questions WHERE 1=1 ${filter}`;
```

**DON'T:**
```typescript
// ❌ NEVER concatenate user input into SQL
const query = `SELECT * FROM categories WHERE slug = '${slug}'`;
await sql.unsafe(query);
```

### Sensitive Data Handling ✅

**DO:**
- Use Authorization header for tokens, not request body
- Redact sensitive fields in logs (already configured in Pino)
- Never log full request bodies that may contain passwords

**DON'T:**
```typescript
// ❌ Don't put tokens in request body
export const resetPasswordSchema = z.object({
  access_token: z.string(), // Will appear in logs
  new_password: z.string(),
});
```

---

## Database

### Use Transactions for Related Operations ✅

When creating/updating related entities, always use transactions.

**DO:**
```typescript
async createWithPayload(data: CreateQuestionData): Promise<QuestionWithPayload> {
  return sql.begin(async (tx) => {
    const [question] = await tx<Question[]>`
      INSERT INTO questions (category_id, prompt) VALUES (${data.categoryId}, ${data.prompt})
      RETURNING *
    `;

    const [payload] = await tx<QuestionPayload[]>`
      INSERT INTO question_payloads (question_id, payload) VALUES (${question.id}, ${data.payload})
      RETURNING *
    `;

    return { ...question, payload: payload.payload };
  });
}
```

**DON'T:**
```typescript
// ❌ Separate calls can leave orphaned records if second fails
const question = await questionsRepo.create(data);
await questionsRepo.createPayload(question.id, data.payload);
```

### Avoid N+1 Queries ✅

Never execute queries in loops. Use bulk operations.

**DO:**
```typescript
// Bulk update with unnest
async reorder(items: ReorderItem[]): Promise<void> {
  const ids = items.map(i => i.id);
  const sortOrders = items.map(i => i.sortOrder);

  await sql`
    UPDATE featured_categories fc
    SET sort_order = v.sort_order
    FROM (SELECT unnest(${ids}::uuid[]) as id, unnest(${sortOrders}::int[]) as sort_order) v
    WHERE fc.id = v.id
  `;
}

// Bulk existence check
async existsAll(ids: string[]): Promise<boolean> {
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM featured_categories WHERE id = ANY(${ids}::uuid[])
  `;
  return parseInt(result.count, 10) === ids.length;
}
```

**DON'T:**
```typescript
// ❌ N queries for N items
for (const item of items) {
  await sql`UPDATE featured_categories SET sort_order = ${item.sortOrder} WHERE id = ${item.id}`;
}

// ❌ N existence checks
for (const item of items) {
  const exists = await repo.exists(item.id);
}
```

### Always Paginate List Endpoints ✅

Never return unbounded result sets.

**DO:**
```typescript
async list(filter?: ListFilter, page = 1, limit = 20): Promise<{ items: Item[]; total: number }> {
  const offset = (page - 1) * limit;

  // Use window function to get total in single query
  const results = await sql<(Item & { total_count: string })[]>`
    SELECT *, COUNT(*) OVER() as total_count
    FROM items
    WHERE 1=1 ${filters}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return {
    items: results.map(({ total_count, ...item }) => item),
    total: results.length > 0 ? parseInt(results[0].total_count, 10) : 0,
  };
}
```

**DON'T:**
```typescript
// ❌ No limit - returns ALL records
async list(): Promise<Item[]> {
  return sql<Item[]>`SELECT * FROM items`;
}
```

### Add Indexes for Query Patterns ✅

Create indexes for columns used in WHERE, JOIN, and ORDER BY clauses.

**Common patterns that need indexes:**
```sql
-- Foreign keys used in filters
CREATE INDEX idx_questions_category_id ON questions(category_id);

-- Status/state columns used in filters
CREATE INDEX idx_questions_status ON questions(status);

-- Composite indexes for common filter combinations
CREATE INDEX idx_questions_category_status ON questions(category_id, status);

-- Unique lookups
CREATE UNIQUE INDEX idx_categories_slug ON categories(slug);
CREATE UNIQUE INDEX idx_user_identities_provider_subject ON user_identities(provider, subject);
```

### Minimize Database Round-trips ✅

**DO:**
```typescript
// Use RETURNING to get created/updated record
const [category] = await sql<Category[]>`
  INSERT INTO categories (slug, name) VALUES (${slug}, ${name})
  RETURNING *
`;

// Use DELETE with RETURNING to check if record existed
const [deleted] = await sql<{ id: string }[]>`
  DELETE FROM categories WHERE id = ${id} RETURNING id
`;
if (!deleted) throw new NotFoundError('Category not found');
```

**DON'T:**
```typescript
// ❌ Separate existence check + operation
const exists = await categoriesRepo.exists(id);
if (!exists) throw new NotFoundError();
await categoriesRepo.delete(id);
```

---

## API Design

### Rate Limiting ✅

Apply rate limiting to all API routes.

```typescript
// General limiter for all routes
const apiLimiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use('/api/v1', apiLimiter);

// Stricter limiter for sensitive routes
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100 });
app.use('/api/v1/auth', authLimiter);
```

### CORS Configuration ✅

Use explicit origin allowlist, never wildcards with credentials.

```typescript
const allowedOrigins = config.CORS_ORIGINS.split(',');

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

### Consistent Response Format ✅

**Success responses:**
```json
// Single item
{ "id": "...", "name": "...", ... }

// List with pagination
{
  "items": [...],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

**Error responses:**
```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable message",
  "details": null,
  "request_id": "uuid"
}
```

---

## Error Handling

### Use Typed Errors ✅

Always throw errors extending `AppError`, never raw `Error`.

**DO:**
```typescript
import { NotFoundError, ConflictError, ValidationError } from '../../core/errors.js';

// In service
if (!category) {
  throw new NotFoundError(`Category not found: ${id}`);
}

if (existingSlug) {
  throw new ConflictError('Category with this slug already exists');
}
```

**DON'T:**
```typescript
// ❌ Don't throw raw errors
throw new Error('Not found');

// ❌ Don't return error responses from services
if (!category) {
  return { error: 'Not found' };
}
```

### Error Codes ✅

Use consistent, uppercase error codes:

| Code | HTTP Status | When to Use |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 422 | Invalid input data |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `CONFLICT` | 409 | Duplicate/constraint violation |
| `UNAUTHORIZED` | 401 | Missing/invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `INTERNAL_ERROR` | 500 | Unexpected errors |

---

## Validation

### Shared Schemas ✅

Put reusable schemas in `src/core/schemas.ts`:

```typescript
// src/core/schemas.ts
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export const i18nFieldSchema = z.record(
  z.string().max(10),
  z.string().max(10000)
).refine(obj => Object.keys(obj).length <= 20);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
```

Then import in module schemas:
```typescript
import { uuidParamSchema, i18nFieldSchema } from '../../core/schemas.js';
```

### Validation Middleware ✅

Use the `validate()` middleware for all inputs:

```typescript
router.post(
  '/',
  validate({
    body: createCategorySchema,
    // query: listQuerySchema,
    // params: uuidParamSchema,
  }),
  controller.create
);
```

---

## Testing

### Mock at the Right Boundary ✅

Mock repositories in service tests, not the database.

**DO:**
```typescript
// Mock the repo
vi.mock('./categories.repo.js', () => ({
  categoriesRepo: {
    create: vi.fn(),
    findBySlug: vi.fn(),
  },
}));

// Test service logic
it('should throw ConflictError if slug exists', async () => {
  categoriesRepo.findBySlug.mockResolvedValue({ id: '...' });
  await expect(categoriesService.create({ slug: 'existing' }))
    .rejects.toThrow(ConflictError);
});
```

### Test Authorization ✅

Always test that unauthorized users cannot access protected endpoints:

```typescript
it('should return 403 for non-admin users', async () => {
  const res = await request(app)
    .delete('/api/v1/categories/123')
    .set('Authorization', `Bearer ${regularUserToken}`);

  expect(res.status).toBe(403);
});
```

---

## Code Organization

### File Naming ✅

```
src/modules/categories/
├── categories.controller.ts  # HTTP handlers
├── categories.service.ts     # Business logic
├── categories.repo.ts        # Database queries
├── categories.schemas.ts     # Zod validation schemas
└── categories.types.ts       # TypeScript types (if needed)
```

### Single Responsibility ✅

Each file should have one clear purpose:
- **Schema files**: Only Zod schemas and inferred types
- **Repo files**: Only database queries, no business rules
- **Service files**: Only business logic, no HTTP or SQL
- **Controller files**: Only HTTP translation, no business logic

### Don't Repeat Yourself (DRY) ✅

**DO:**
- Put shared schemas in `src/core/schemas.ts`
- Put shared types in `src/core/types.ts`
- Put shared utilities in `src/core/utils.ts`
- Consolidate Express type extensions in `src/types/express.d.ts`

**DON'T:**
- Define the same schema in multiple files
- Copy-paste similar code across modules
- Create module-specific utilities that could be shared

### Keep It Simple (KISS) ✅

**DO:**
- Solve the immediate problem
- Use straightforward patterns
- Optimize only when needed (with measurements)

**DON'T:**
- Over-abstract for hypothetical future needs
- Add configuration for unlikely scenarios
- Implement caching without measuring first

---

## Quick Reference Checklist

Before submitting a PR, verify:

- [ ] Authorization middleware applied to all mutation endpoints
- [ ] All user input validated with Zod (with length limits)
- [ ] Redirect URLs validated against allowlist
- [ ] Related entity operations wrapped in transactions
- [ ] No N+1 queries (no queries in loops)
- [ ] List endpoints have pagination
- [ ] Appropriate indexes exist for query patterns
- [ ] Errors use typed `AppError` classes
- [ ] No raw `req.body`/`req.query`/`req.params` (use `req.validated.*`)
- [ ] No Express types in service layer
- [ ] Shared schemas imported from `src/core/schemas.ts`
- [ ] Tests cover both happy path and error cases
- [ ] Authorization tested (403 for unauthorized users)
