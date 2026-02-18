# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MANDATORY: Read Before Writing Code

Before writing ANY code, you MUST read and follow:
- **`DEVELOPMENT_GUIDELINES.md`** — Coding standards, security rules, DB patterns, error handling
- **`docs/coding-patterns.md`** — Detailed coding standards, naming conventions, architecture rules
- **`TYPES.md`** — API type flow (Zod → OpenAPI → frontend), schema patterns, auth transport
- **`docs/API_TYPE_SYNC.md`** — How types sync between backend and frontend apps
- **`docs/websocket-walkthrough.md`** — Full realtime system architecture, Redis usage, game flow

Always match existing patterns. When in doubt, look at how similar code is already written in the codebase.

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
- **Controllers** (`src/modules/*/*.controller.ts`): Translate HTTP to service calls, return response DTOs.
- **Services** (`src/modules/*/*.service.ts`): Business logic. No Express types (`req`/`res`).
- **Repositories** (`src/modules/*/*.repo.ts`): Database queries only. No business rules.
- **Providers** (`src/modules/*/*.provider.ts`): External API integrations (Supabase Auth).

**Realtime (Socket.IO) follows the same layering:**
- **Handlers** (`src/realtime/handlers/`): Validate payloads with Zod, delegate to services. No business logic.
- **Realtime Services** (`src/realtime/services/`): Socket-specific use-cases, orchestrate domain logic, emit events.
- **Schemas** (`src/realtime/schemas/`): Zod validation for socket event payloads.

**Key directories:**
- `src/core/` — Config, errors, logging, request context
- `src/http/middleware/` — Auth, validation, error handling, request ID
- `src/http/openapi/` — OpenAPI/Swagger documentation
- `src/modules/` — Feature modules (auth, users, matches, lobbies, ranked)
- `src/db/` — Database connection (postgres.js) and generated types
- `src/realtime/` — Socket.IO server, handlers, services, match flow engine

## Type Safety — STRICT

- Strict TypeScript (`noImplicitAny`, `strictNullChecks`) — enforced
- **No `any`** unless absolutely necessary and documented why
- All untrusted input validated with Zod (HTTP requests, socket payloads, env vars)
- DB types auto-generated from schema: `npm run db:types` → `src/db/database.types.ts`
- API types flow: Zod schemas → OpenAPI spec → frontend TypeScript types
- Socket event types defined in `src/realtime/socket.types.ts` — shared with frontend
- Always use parameterized queries via postgres.js tagged templates (never string concatenation)

## Key Patterns

**Error handling:** Use typed errors extending `AppError` from `src/core/errors.ts`. Never throw raw `Error`. Response format:
```json
{"code": "ERROR_CODE", "message": "...", "details": null, "request_id": "..."}
```

**Input validation:** All requests validated via Zod schemas using `validate()` middleware. Schemas in `*.schemas.ts` files. Socket payloads also validated with Zod in handlers.

**Auth:** JWT validation via Supabase. `authMiddleware` for HTTP routes. Socket auth in `socket-auth.ts` middleware during handshake.

**Database:** Uses `postgres` package (postgres.js), NOT pg. Connection in `src/db/index.ts`. Always use transactions for related operations. Never N+1 queries. Always paginate list endpoints.

**API versioning:** All endpoints under `/api/v1/*`. OpenAPI docs at `/api-docs`.

**Distributed locking:** Redis-based locks (`src/realtime/locks.ts`) to prevent race conditions in concurrent operations (round resolution, draft completion, etc.).

## API Type Synchronization

Frontend apps (CMS, Web) use auto-generated TypeScript types from the OpenAPI spec.

```bash
# Export OpenAPI spec (for CI/CD)
npm run api:export

# Frontend: Regenerate types after API changes
cd ../cms && npm run api:sync:local
cd ../frontend-web-next && npm run api:sync:local
```

**After changing API schemas:**
1. Update Zod schemas in `src/http/openapi/registry.ts`
2. Frontends run `npm run api:sync:local` to regenerate types
3. TypeScript catches any mismatches at compile time

See `docs/API_TYPE_SYNC.md` for full documentation.

## File Organization

```
src/modules/<feature>/
├── <feature>.controller.ts  # HTTP handlers
├── <feature>.service.ts     # Business logic
├── <feature>.repo.ts        # Database queries
├── <feature>.schemas.ts     # Zod validation schemas
└── <feature>.types.ts       # TypeScript types
```

Each file has ONE responsibility. Shared schemas in `src/core/schemas.ts`, shared types in `src/core/types.ts`.

## PR Checklist

Before submitting code, verify:
- [ ] `npm run lint` passes (type-check)
- [ ] `npm test` passes
- [ ] Authorization middleware on all mutation endpoints
- [ ] All input validated with Zod (with length limits)
- [ ] Related DB operations wrapped in transactions
- [ ] No N+1 queries
- [ ] Errors use typed `AppError` classes
- [ ] No Express types in service layer
- [ ] No `any` types
