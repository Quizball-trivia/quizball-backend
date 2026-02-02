# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # Start dev server with hot reload (tsx watch)
npm run build            # TypeScript compile to dist/
npm run start            # Run compiled JS from dist/
npm run lint             # Type-check without emitting (tsc --noEmit)

# Testing
npm test                 # Run all tests once (vitest run)
npm run test:watch       # Run tests in watch mode
npx vitest run tests/path/to/file.test.ts  # Run single test file

# Database (requires Supabase CLI linked)
npm run db:types         # Regenerate TypeScript types from schema
npm run db:migrate:new   # Create new migration file
npm run db:migrate:up    # Apply migrations
npm run db:reset         # Reset database

# Docker
npm run docker:start     # Start containers
npm run docker:stop      # Stop containers
```

## Architecture

This is an Express + TypeScript backend using a layered architecture:

```
Routes → Controllers → Services → Repositories/Providers
```

**Layer responsibilities:**
- **Routes** (`src/http/routes/`): Wire endpoints with middleware. No business logic.
- **Controllers** (`src/modules/*/\*.controller.ts`): Translate HTTP to service calls, return response DTOs.
- **Services** (`src/modules/*/\*.service.ts`): Business logic. No Express types (`req`/`res`).
- **Repositories** (`src/modules/*/\*.repo.ts`): Database queries only. No business rules.
- **Providers** (`src/modules/*/\*.provider.ts`): External API integrations (Supabase Auth).

**Key directories:**
- `src/core/` - Config, errors, logging, request context
- `src/http/middleware/` - Auth, validation, error handling, request ID
- `src/http/openapi/` - OpenAPI/Swagger documentation
- `src/modules/` - Feature modules (auth, users)
- `src/db/` - Database connection (postgres.js) and types

## Key Patterns

**Error handling:** Use typed errors extending `AppError` from `src/core/errors.ts`. Never throw raw errors. Response format:
```json
{"code": "ERROR_CODE", "message": "...", "details": null, "request_id": "..."}
```

**Input validation:** All requests validated via Zod schemas using the `validate()` middleware. Schemas defined in `*.schemas.ts` files.

**Auth:** JWT validation via Supabase. Use `authMiddleware` to protect routes. Authenticated user available as `req.user`.

**Database:** Uses `postgres` package (postgres.js), not pg. Connection in `src/db/index.ts`.

**API versioning:** All endpoints under `/api/v1/*`. OpenAPI docs at `/api-docs`.

## Type Safety

- Strict TypeScript (`noImplicitAny`, `strictNullChecks`)
- No `any` unless absolutely necessary
- All untrusted input validated with Zod

## API Type Synchronization

Frontend apps (CMS, Web) use auto-generated TypeScript types from the OpenAPI spec.

```bash
# Export OpenAPI spec (for CI/CD)
npm run api:export

# Frontend: Regenerate types after API changes
cd ../cms && npm run api:sync:local
cd ../web && npm run api:sync:local
```

**After changing API schemas:**
1. Update Zod schemas in `src/http/openapi/registry.ts`
2. Frontends run `npm run api:sync:local` to regenerate types
3. TypeScript catches any mismatches at compile time

See `docs/API_TYPE_SYNC.md` for full documentation.
