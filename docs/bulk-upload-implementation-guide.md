# Bulk Upload Feature - Backend Implementation Guide

## Table of Contents
1. [Overview & Architecture](#overview--architecture)
2. [Step-by-Step Implementation](#step-by-step-implementation)
3. [Design Decisions & Why](#design-decisions--why)
4. [How to Apply This Pattern](#how-to-apply-this-pattern)
5. [Common Pitfalls to Avoid](#common-pitfalls-to-avoid)

---

## Overview & Architecture

### The Big Picture

When adding a new API endpoint to this codebase, you follow a **layered architecture**:

```
HTTP Request
    ↓
Routes (routing + middleware)
    ↓
Controller (HTTP translation)
    ↓
Service (business logic)
    ↓
Repository (database access)
    ↓
Database
```

**Why layers?** Each layer has a single responsibility:
- **Routes**: "Which endpoint maps to which controller method?"
- **Controller**: "How do I translate HTTP requests/responses?"
- **Service**: "What are the business rules?"
- **Repository**: "How do I query the database?"

This separation makes code:
- ✅ Easier to test (mock one layer at a time)
- ✅ Easier to understand (each file has one job)
- ✅ Easier to change (modify business logic without touching HTTP)
- ✅ Reusable (service can be called from anywhere, not just HTTP)

---

## Step-by-Step Implementation

### Step 1: Define the Data Contract (Schemas)

**File**: `src/modules/questions/questions.schemas.ts`

**What I created:**
```typescript
export const bulkCreateQuestionsSchema = z.object({
  category_id: z.string().uuid(),
  questions: z
    .array(
      createQuestionBaseSchema.omit({ category_id: true }).refine(...)
    )
    .min(1, 'At least one question required')
    .max(100, 'Maximum 100 questions per upload'),
});

export const bulkCreateResponseSchema = z.object({
  total: z.number(),
  successful: z.number(),
  failed: z.number(),
  created: z.array(questionResponseSchema),
  errors: z.array(bulkCreateErrorSchema),
});
```

**Why this way?**

1. **Schemas First**: I always start with schemas because they define the contract between frontend and backend. This is the "what" - what data flows in and out.

2. **Reuse Existing Schemas**: Notice `createQuestionBaseSchema.omit({ category_id: true })`
   - **Don't Repeat Yourself (DRY)**: The individual question structure is the same as creating a single question
   - **Why omit category_id?** Because in bulk upload, the category is specified once at the top level, not per question
   - This ensures consistency - if we change how a single question works, bulk upload automatically inherits those changes

3. **Validation Limits**: `min(1).max(100)`
   - **Why 100 max?** Performance and UX balance
   - Too low: User has to upload multiple times
   - Too high: Risk of timeout, memory issues, poor UX (no progress feedback)
   - 100 is a sweet spot for bulk operations

4. **Detailed Response Schema**:
   ```typescript
   {
     total: number,      // How many you tried
     successful: number, // How many worked
     failed: number,     // How many failed
     created: [],        // The actual questions created
     errors: []          // What went wrong for failures
   }
   ```

   **Why this structure?**
   - Supports **partial success** - some questions create, some fail
   - Frontend can show meaningful feedback: "Created 47 of 50 questions. 3 failed."
   - Errors array lets user know exactly what to fix

5. **TypeScript Types**: `export type BulkCreateQuestionsRequest = z.infer<typeof bulkCreateQuestionsSchema>`
   - Zod schemas give us both runtime validation AND TypeScript types
   - Single source of truth - no type drift

**Key Learning**: Start with the data contract. What goes in? What comes out? Define this clearly before writing any logic.

---

### Step 2: Implement Business Logic (Service)

**File**: `src/modules/questions/questions.service.ts`

**What I created:**
```typescript
async bulkCreate(
  categoryId: string,
  questions: Omit<CreateQuestionRequest, 'category_id'>[]
): Promise<BulkCreateResponse> {
  // 1. Validate category exists once
  const categoryExists = await categoriesRepo.exists(categoryId);
  if (!categoryExists) {
    throw new BadRequestError('Category not found');
  }

  // 2. Initialize results tracking
  const results: BulkCreateResponse = {
    total: questions.length,
    successful: 0,
    failed: 0,
    created: [],
    errors: [],
  };

  // 3. Process each question
  for (let i = 0; i < questions.length; i++) {
    try {
      // Create question
      const question = await questionsRepo.createWithPayload(...);
      results.created.push(...);
      results.successful++;
    } catch (error) {
      // Don't stop on error, continue with next question
      results.failed++;
      results.errors.push({
        index: i,
        question: questions[i],
        error: error.message,
      });
      logger.error('Failed to create question', { error, index: i });
    }
  }

  return results;
}
```

**Why this way?**

1. **Category Validation Once**:
   ```typescript
   const categoryExists = await categoriesRepo.exists(categoryId);
   if (!categoryExists) {
     throw new BadRequestError('Category not found');
   }
   ```

   **Why check once, not per question?**
   - **Performance**: 1 database query instead of 50 (if uploading 50 questions)
   - **Logic**: If category is invalid, fail fast - don't waste time trying to create questions
   - **Transaction safety**: Category can't be deleted mid-upload (validated upfront)

2. **Fail-Safe Loop Pattern**:
   ```typescript
   for (let i = 0; i < questions.length; i++) {
     try {
       // Create question
       results.successful++;
     } catch (error) {
       // Log error but continue
       results.failed++;
       results.errors.push(...);
     }
   }
   ```

   **Why not stop on first error?**
   - **User Experience**: User uploads 50 questions, 1 is malformed. Do you want to reject all 50 or create 49?
   - **Partial Success**: Better UX to create what's valid and report what failed
   - **Debugging**: Error array tells user exactly which questions have issues

   **Alternative (not chosen)**: Wrap everything in a transaction and rollback on any error
   - **Pros**: All-or-nothing consistency
   - **Cons**: Poor UX for bulk operations - one bad question rejects entire upload

3. **Index Tracking**:
   ```typescript
   for (let i = 0; i < questions.length; i++) {
     // ...
     results.errors.push({
       index: i,  // ← This tells user "Question #3 failed"
       question: questions[i],
       error: error.message,
     });
   }
   ```

   **Why include index?**
   - User sees: "Question #3 (line 42): Missing difficulty level"
   - Without index: "Some question failed: Missing difficulty level" (which one?)

4. **Logging Strategy**:
   ```typescript
   logger.info('Bulk question upload completed', {
     total: results.total,
     successful: results.successful,
     failed: results.failed,
     categoryId,
   });
   ```

   **Why log at the end?**
   - **Debugging**: Quick overview in logs
   - **Metrics**: Track bulk upload success rates
   - **Auditing**: Know who uploaded how many questions when

5. **Error Handling**:
   ```typescript
   catch (error) {
     results.errors.push({
       error: error instanceof Error ? error.message : 'Unknown error'
     });
   }
   ```

   **Why check `instanceof Error`?**
   - JavaScript can throw anything: `throw "string"`, `throw {}`
   - Type-safe error message extraction
   - Prevents runtime crashes from `.message` on non-Error objects

**Key Learning**: Service layer contains pure business logic. No HTTP concepts (req, res). No SQL queries. Just "given these inputs, perform this business operation."

---

### Step 3: Handle HTTP Translation (Controller)

**File**: `src/modules/questions/questions.controller.ts`

**What I created:**
```typescript
async bulkCreate(req: Request, res: Response): Promise<void> {
  const data = req.validated.body as BulkCreateQuestionsRequest;

  const result = await questionsService.bulkCreate(
    data.category_id,
    data.questions
  );

  // Return 201 even with partial failures
  res.status(201).json(result);
}
```

**Why this way?**

1. **Trust `req.validated.body`**:
   ```typescript
   const data = req.validated.body as BulkCreateQuestionsRequest;
   ```

   **Why no manual validation?**
   - Validation happens in middleware (see Routes step)
   - By the time we reach controller, data is guaranteed to match schema
   - Controller trusts the middleware layer
   - **If we validated here too**: Duplicate logic, harder to maintain

2. **Status Code 201 Even With Partial Failures**:
   ```typescript
   res.status(201).json(result);
   ```

   **Why 201, not 400 on partial failure?**
   - **201 Created**: At least some resources were created
   - Frontend checks `result.failed` to know if there were issues
   - **Alternative approaches**:
     - 207 Multi-Status: Technically correct for partial success, but uncommon
     - 400 Bad Request: Wrong - we DID create resources successfully
     - 200 OK: Not wrong, but 201 better indicates resource creation

   **Real-world analogy**: You order 10 items on Amazon. 8 ship, 2 are out of stock. Amazon doesn't reject your entire order - they ship what's available and notify you about the rest.

3. **Simple Controller**:
   - Controller is a thin translation layer
   - Extract data from HTTP request → Call service → Format HTTP response
   - No business logic here (that's in service)
   - No database queries here (that's in repository)

**Key Learning**: Controllers are translators. They speak HTTP to the outside world and pure TypeScript to the service layer.

---

### Step 4: Wire Up Routing (Routes)

**File**: `src/http/routes/questions.routes.ts`

**What I created:**
```typescript
router.post(
  '/bulk',  // ← BEFORE /:id route!
  authMiddleware,
  requireRole('admin'),
  validate({ body: bulkCreateQuestionsSchema }),
  questionsController.bulkCreate
);

router.post(
  '/',
  authMiddleware,
  requireRole('admin'),
  validate({ body: createQuestionSchema }),
  questionsController.create
);
```

**Why this way?**

1. **Route Order Matters**:
   ```typescript
   router.post('/bulk', ...)     // ✅ Specific route first
   router.post('/', ...)         // ✅ Generic route after
   router.get('/:id', ...)       // ✅ Parameterized route last
   ```

   **Why this order?**
   - Express matches routes **top to bottom**
   - If `/:id` came first, it would match `/bulk` (treating "bulk" as an id)
   - **Rule of thumb**: Specific → Generic → Parameterized

2. **Middleware Chain**:
   ```typescript
   router.post(
     '/bulk',
     authMiddleware,           // 1. Is user logged in?
     requireRole('admin'),     // 2. Is user an admin?
     validate({ body: ... }),  // 3. Is request body valid?
     questionsController.bulkCreate  // 4. Handle request
   );
   ```

   **Why this order?**
   - **Fail fast**: Check auth before expensive validation
   - **Security first**: Don't process invalid requests from unauthenticated users
   - **Separation of concerns**: Each middleware does one thing

   **Flow**:
   ```
   Request comes in
     ↓
   authMiddleware: Check JWT token
     ↓ (if invalid → 401 Unauthorized)
   requireRole: Check user.role === 'admin'
     ↓ (if not admin → 403 Forbidden)
   validate: Check body matches schema
     ↓ (if invalid → 400 Bad Request with details)
   controller: Process valid request
   ```

3. **Validation Middleware**:
   ```typescript
   validate({ body: bulkCreateQuestionsSchema })
   ```

   **What this does**:
   - Runs Zod validation on `req.body`
   - If valid: Attaches validated data to `req.validated.body` and calls `next()`
   - If invalid: Returns 400 with detailed error messages
   - **Why not validate in controller?**
     - Middleware is reusable across routes
     - Controller stays simple (trust validated data)
     - Consistent error format across all endpoints

4. **Controller Method Binding**:
   ```typescript
   questionsController.bulkCreate
   ```

   **Why not**:
   ```typescript
   (req, res) => questionsController.bulkCreate(req, res)
   ```

   - Controllers are plain objects with methods
   - Express calls the method directly
   - **Note**: Some codebases use `.bind(questionsController)` for `this` context
   - This codebase uses arrow functions in controllers, so binding not needed

**Key Learning**: Routes are configuration. They declare "for this path, apply these middleware, then call this controller method." Order matters!

---

### Step 5: Document the API (OpenAPI)

**File**: `src/http/openapi/registry.ts`

**What I created:**
```typescript
// 1. Register response schema as component
const bulkCreateResponseSchema = z.object({
  total: z.number().int(),
  successful: z.number().int(),
  failed: z.number().int(),
  created: z.array(questionResponseSchema),
  errors: z.array(/* ... */),
}).openapi('BulkCreateResponse');

registry.register('BulkCreateResponse', bulkCreateResponseSchema);

// 2. Register endpoint
registry.registerPath({
  method: 'post',
  path: '/api/v1/questions/bulk',
  summary: 'Bulk create questions',
  description: 'Create multiple questions in a single request. Maximum 100 questions per upload. Requires admin role.',
  tags: ['Questions'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            category_id: z.string().uuid(),
            questions: z.array(/* ... */).min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Questions created (may include partial failures)',
      content: { 'application/json': { schema: bulkCreateResponseSchema } },
    },
    400: { /* ... */ },
    401: { /* ... */ },
    403: { /* ... */ },
  },
});
```

**Why this way?**

1. **OpenAPI First**:
   - This project uses `@asteasolutions/zod-to-openapi`
   - Define schemas in code → Auto-generate OpenAPI spec
   - **Alternative**: Write OpenAPI YAML by hand
     - **Pros**: More control
     - **Cons**: Out of sync with code, manual maintenance

2. **Register Reusable Schemas**:
   ```typescript
   registry.register('BulkCreateResponse', bulkCreateResponseSchema);
   ```

   **Why register?**
   - Makes schema reusable in docs: `$ref: '#/components/schemas/BulkCreateResponse'`
   - Frontend generators can create TypeScript types from this
   - Single source of truth

3. **Detailed Response Codes**:
   ```typescript
   responses: {
     201: { description: 'Questions created (may include partial failures)' },
     400: { description: 'Invalid request or category not found' },
     401: { description: 'Not authenticated' },
     403: { description: 'Insufficient permissions (admin role required)' },
   }
   ```

   **Why document every response?**
   - Frontend developers know what to expect
   - Auto-generated API clients handle errors correctly
   - API testing tools (Postman, Insomnia) show proper examples

4. **Include Security Requirements**:
   ```typescript
   security: [{ bearerAuth: [] }]
   ```

   **What this does**:
   - Shows lock icon in Swagger UI
   - Frontend devs know to include `Authorization: Bearer <token>`
   - API clients auto-add auth headers

**Key Learning**: Good API documentation is part of the code, not separate. Tools like Swagger/OpenAPI make APIs self-documenting.

---

## Design Decisions & Why

### Decision 1: Partial Success vs All-or-Nothing

**I chose: Partial Success**

```typescript
// Continue processing even if some questions fail
for (let i = 0; i < questions.length; i++) {
  try {
    // Create question
  } catch (error) {
    // Log error but continue with next question
    results.failed++;
  }
}
```

**Alternative: All-or-Nothing (Transaction)**
```typescript
return sql.begin(async (tx) => {
  for (const question of questions) {
    await tx.createQuestion(question);
  }
  // If any fails, rollback all
});
```

**Why I chose partial success:**

| Aspect | Partial Success | All-or-Nothing |
|--------|----------------|----------------|
| **UX** | ✅ Better - create what's valid | ❌ Worse - one error rejects all |
| **User Feedback** | ✅ Clear - "3 of 50 failed" | ❌ Vague - "upload failed" |
| **Debugging** | ✅ Easy - see which questions failed | ❌ Hard - fix first error, try again |
| **Data Consistency** | ⚠️ Partial state | ✅ Always consistent |
| **Retry Complexity** | ✅ Retry only failed | ❌ Retry everything |

**When to use All-or-Nothing:**
- Financial transactions (payment processing)
- Critical data where partial state is dangerous
- User explicitly requests atomic operation

**When to use Partial Success:**
- Bulk uploads (our case)
- Batch processing
- User can review and fix errors

---

### Decision 2: Validate Category Once vs Per Question

**I chose: Once at the start**

```typescript
// Validate category exists once
const categoryExists = await categoriesRepo.exists(categoryId);
if (!categoryExists) {
  throw new BadRequestError('Category not found');
}

// Then create all questions
for (const question of questions) {
  await createQuestion({ categoryId, ...question });
}
```

**Alternative: Validate per question**
```typescript
for (const question of questions) {
  // Check category exists for each question
  const categoryExists = await categoriesRepo.exists(categoryId);
  await createQuestion({ categoryId, ...question });
}
```

**Why validate once:**

| Approach | Database Queries | Risk | Performance |
|----------|-----------------|------|-------------|
| **Once** | 1 | ⚠️ Category could be deleted mid-upload (rare) | ✅ Fast |
| **Per Question** | N | ✅ Always current | ❌ Slow (N extra queries) |

**Tradeoff Analysis:**
- **Risk of "category deleted mid-upload"**: Very low
  - Most apps don't allow deleting categories with questions
  - If it happens, foreign key constraint catches it
  - Failed questions go into `errors` array
- **Performance gain**: Significant for large uploads
  - 50 questions = 50 saved queries
  - Faster response time
  - Less database load

**When to validate per item:**
- User can specify different category per question
- Category can change during operation
- Operation takes a long time (minutes/hours)

---

### Decision 3: Max 100 Questions per Upload

**I chose: 100 as the limit**

```typescript
questions: z.array(...)
  .min(1, 'At least one question required')
  .max(100, 'Maximum 100 questions per upload')
```

**Why 100?**

**Too Low (e.g., 10)**:
- ❌ User uploads 50 questions → needs 5 separate uploads
- ❌ Poor UX
- ❌ More HTTP overhead

**Too High (e.g., 1000)**:
- ❌ Risk of timeout (default 30s request timeout)
- ❌ Memory issues (large request body)
- ❌ No progress feedback (user waits, unsure if it's working)
- ❌ Hard to debug (1000 questions in one request)

**Sweet Spot (100)**:
- ✅ Realistic use case (teacher uploads 1-2 question sheets)
- ✅ Completes in reasonable time (~10-30s for 100 questions)
- ✅ Easy to implement (no async jobs needed)
- ✅ Good for debugging (manageable error list)

**When you need higher limits:**
- Implement async job queue (Bull, BullMQ)
- Return job ID immediately
- Process in background
- Poll for completion
- Example: `POST /bulk` → `{ jobId: "123" }` → `GET /jobs/123` → `{ status: "processing", completed: 47/500 }`

---

### Decision 4: Error Response Structure

**I chose: Detailed error array**

```typescript
{
  total: 50,
  successful: 47,
  failed: 3,
  created: [/* 47 questions */],
  errors: [
    { index: 12, question: {...}, error: "Missing difficulty" },
    { index: 28, question: {...}, error: "Invalid option format" },
    { index: 41, question: {...}, error: "Duplicate question text" }
  ]
}
```

**Alternative: Simple error message**
```typescript
{
  success: false,
  message: "Some questions failed to create"
}
```

**Why detailed errors:**

**User Experience:**
```
❌ Bad UX: "Some questions failed"
   → User: Which ones? What's wrong? Do I retry all 50?

✅ Good UX: "47 of 50 questions created. Failed questions: #12 (Missing difficulty), #28 (Invalid option format), #41 (Duplicate)"
   → User knows exactly what to fix
```

**Developer Experience:**
```typescript
// Frontend can show specific errors
{result.errors.map(err => (
  <Alert key={err.index}>
    Question #{err.index}: {err.error}
  </Alert>
))}
```

**Cost:**
- Slightly larger response size (negligible)
- More complex response schema (worth it)

---

## How to Apply This Pattern

### Adding a New Bulk Operation (e.g., Bulk Delete)

**1. Define Schema (`questions.schemas.ts`)**
```typescript
export const bulkDeleteQuestionsSchema = z.object({
  question_ids: z.array(z.string().uuid()).min(1).max(100),
});

export const bulkDeleteResponseSchema = z.object({
  total: z.number(),
  successful: z.number(),
  failed: z.number(),
  deleted_ids: z.array(z.string()),
  errors: z.array(z.object({
    id: z.string(),
    error: z.string(),
  })),
});
```

**2. Add Service Method (`questions.service.ts`)**
```typescript
async bulkDelete(questionIds: string[]): Promise<BulkDeleteResponse> {
  const results = {
    total: questionIds.length,
    successful: 0,
    failed: 0,
    deleted_ids: [],
    errors: [],
  };

  for (const id of questionIds) {
    try {
      await questionsRepo.delete(id);
      results.deleted_ids.push(id);
      results.successful++;
    } catch (error) {
      results.failed++;
      results.errors.push({ id, error: error.message });
    }
  }

  return results;
}
```

**3. Add Controller Method (`questions.controller.ts`)**
```typescript
async bulkDelete(req: Request, res: Response): Promise<void> {
  const { question_ids } = req.validated.body as BulkDeleteQuestionsRequest;

  const result = await questionsService.bulkDelete(question_ids);

  res.status(200).json(result);
}
```

**4. Add Route (`questions.routes.ts`)**
```typescript
router.delete(
  '/bulk',
  authMiddleware,
  requireRole('admin'),
  validate({ body: bulkDeleteQuestionsSchema }),
  questionsController.bulkDelete
);
```

**5. Document in OpenAPI (`openapi/registry.ts`)**
```typescript
registry.registerPath({
  method: 'delete',
  path: '/api/v1/questions/bulk',
  summary: 'Bulk delete questions',
  // ... rest of documentation
});
```

**You just followed the same pattern!** 🎉

---

### Adding a Completely New Resource (e.g., Quizzes)

**Directory Structure:**
```
src/modules/quizzes/
├── quizzes.repo.ts         # Database queries
├── quizzes.service.ts      # Business logic
├── quizzes.controller.ts   # HTTP handling
├── quizzes.schemas.ts      # Zod schemas + types
└── index.ts                # Export everything
```

**1. Create Schemas (`quizzes.schemas.ts`)**
```typescript
export const createQuizSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  question_ids: z.array(z.string().uuid()).min(1).max(50),
});

export const quizResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  question_count: z.number(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
```

**2. Create Repository (`quizzes.repo.ts`)**
```typescript
export const quizzesRepo = {
  async create(data: CreateQuizData): Promise<Quiz> {
    const [quiz] = await sql<Quiz[]>`
      INSERT INTO quizzes (title, description)
      VALUES (${data.title}, ${data.description})
      RETURNING *
    `;
    return quiz;
  },

  async getById(id: string): Promise<Quiz | null> {
    const [quiz] = await sql<Quiz[]>`
      SELECT * FROM quizzes WHERE id = ${id}
    `;
    return quiz ?? null;
  },
};
```

**3. Create Service (`quizzes.service.ts`)**
```typescript
export const quizzesService = {
  async create(data: CreateQuizRequest): Promise<Quiz> {
    // Business logic: Validate all questions exist
    const questionsExist = await Promise.all(
      data.question_ids.map(id => questionsRepo.exists(id))
    );

    if (questionsExist.some(exists => !exists)) {
      throw new BadRequestError('Some questions do not exist');
    }

    // Create quiz
    const quiz = await quizzesRepo.create({
      title: data.title,
      description: data.description,
    });

    // Associate questions
    await quizzesRepo.addQuestions(quiz.id, data.question_ids);

    return quiz;
  },
};
```

**4. Create Controller (`quizzes.controller.ts`)**
```typescript
export const quizzesController = {
  async create(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as CreateQuizRequest;
    const quiz = await quizzesService.create(data);
    res.status(201).json(quiz);
  },
};
```

**5. Create Routes (`routes/quizzes.routes.ts`)**
```typescript
const router = Router();

router.post(
  '/',
  authMiddleware,
  validate({ body: createQuizSchema }),
  quizzesController.create
);

export const quizzesRoutes = router;
```

**6. Register Routes (`routes/index.ts`)**
```typescript
import { quizzesRoutes } from './quizzes.routes';

app.use('/api/v1/quizzes', quizzesRoutes);
```

---

## Common Pitfalls to Avoid

### ❌ Pitfall 1: Business Logic in Controllers

**Bad:**
```typescript
// questions.controller.ts
async bulkCreate(req: Request, res: Response) {
  const { category_id, questions } = req.body;

  // ❌ Validation in controller
  if (!category_id) {
    return res.status(400).json({ error: 'Category required' });
  }

  // ❌ Database query in controller
  const category = await sql`SELECT * FROM categories WHERE id = ${category_id}`;
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  // ❌ Business logic in controller
  const results = [];
  for (const q of questions) {
    const created = await sql`INSERT INTO questions ...`;
    results.push(created);
  }

  res.json(results);
}
```

**Why it's bad:**
- Can't test logic without HTTP
- Can't reuse logic (what if you need bulk create from CLI?)
- Hard to read (everything mixed together)

**Good:**
```typescript
// questions.controller.ts - Thin layer
async bulkCreate(req: Request, res: Response) {
  const data = req.validated.body;
  const result = await questionsService.bulkCreate(data.category_id, data.questions);
  res.status(201).json(result);
}

// questions.service.ts - All logic here
async bulkCreate(categoryId, questions) {
  // Validation
  // Database calls
  // Business rules
  // Return results
}
```

---

### ❌ Pitfall 2: Not Using Validation Middleware

**Bad:**
```typescript
async bulkCreate(req: Request, res: Response) {
  const { category_id, questions } = req.body;

  // ❌ Manual validation
  if (!category_id || typeof category_id !== 'string') {
    return res.status(400).json({ error: 'Invalid category_id' });
  }

  if (!Array.isArray(questions)) {
    return res.status(400).json({ error: 'questions must be array' });
  }

  if (questions.length === 0) {
    return res.status(400).json({ error: 'At least one question required' });
  }

  // ... 50 more lines of validation
}
```

**Good:**
```typescript
// Define schema once
const bulkCreateSchema = z.object({
  category_id: z.string().uuid(),
  questions: z.array(...).min(1).max(100),
});

// Use in route
router.post('/bulk',
  validate({ body: bulkCreateSchema }), // ✅ Automatic validation
  controller.bulkCreate
);

// Controller trusts validated data
async bulkCreate(req: Request, res: Response) {
  const data = req.validated.body; // ✅ Already validated
  // No manual checks needed
}
```

---

### ❌ Pitfall 3: Returning Wrong Status Codes

**Bad:**
```typescript
// Everything returns 200
async bulkCreate(req: Request, res: Response) {
  const result = await service.bulkCreate(...);
  res.status(200).json(result); // ❌ Should be 201 for creation
}

async getById(req: Request, res: Response) {
  const question = await service.getById(id);
  if (!question) {
    return res.status(200).json(null); // ❌ Should be 404
  }
  res.json(question);
}
```

**Good:**
```typescript
// Correct status codes
async bulkCreate(req: Request, res: Response) {
  const result = await service.bulkCreate(...);
  res.status(201).json(result); // ✅ 201 Created
}

async getById(req: Request, res: Response) {
  const question = await service.getById(id);
  if (!question) {
    throw new NotFoundError('Question not found'); // ✅ 404
  }
  res.json(question); // ✅ 200 OK
}
```

**HTTP Status Code Cheat Sheet:**
- `200 OK`: Successful GET, PUT, PATCH
- `201 Created`: Successful POST
- `204 No Content`: Successful DELETE
- `400 Bad Request`: Validation error
- `401 Unauthorized`: Not authenticated
- `403 Forbidden`: Authenticated but not authorized
- `404 Not Found`: Resource doesn't exist
- `409 Conflict`: Resource conflict (duplicate, version mismatch)
- `500 Internal Server Error`: Unexpected error

---

### ❌ Pitfall 4: Not Handling Errors Consistently

**Bad:**
```typescript
// Different error formats everywhere
async create(req, res) {
  try {
    // ...
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async bulkCreate(req, res) {
  try {
    // ...
  } catch (error) {
    res.status(400).send(error.toString());
  }
}
```

**Good:**
```typescript
// Use error handling middleware (already in codebase)
// src/http/middleware/error-handler.ts

// In routes, just throw errors
async create(req, res) {
  if (!categoryExists) {
    throw new BadRequestError('Category not found');
  }
  // Middleware handles formatting
}

// Error middleware catches and formats consistently
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    code: err.code,
    message: err.message,
    details: err.details,
    request_id: req.id,
  });
});
```

---

### ❌ Pitfall 5: Ignoring Route Order

**Bad:**
```typescript
router.get('/:id', getById);         // ❌ Matches /bulk
router.get('/bulk', getBulkStatus);  // ❌ Never reached!
```

**Good:**
```typescript
router.get('/bulk', getBulkStatus);  // ✅ Specific first
router.get('/:id', getById);         // ✅ Generic after
```

---

## Summary: The Mental Model

When adding a new API endpoint, think in layers:

```
1. SCHEMA: What data comes in? What goes out?
   └─> Define Zod schemas

2. SERVICE: What's the business logic?
   └─> Implement service method (pure logic, no HTTP)

3. CONTROLLER: How do I translate HTTP ↔ Service?
   └─> Extract request data, call service, format response

4. ROUTES: How do I wire it up?
   └─> Path + middleware + controller

5. DOCS: How do others use this?
   └─> OpenAPI documentation
```

**Key Principles:**
1. **Separation of Concerns**: Each layer has one job
2. **Fail Fast**: Validate early (auth, then validation, then logic)
3. **User First**: Design errors for humans (detailed, actionable)
4. **Type Safety**: Let TypeScript catch bugs at compile time
5. **Consistency**: Follow existing patterns in the codebase

**You now understand the backend architecture!** 🎉

Apply this pattern to any new feature, and you'll have clean, maintainable, testable code.
