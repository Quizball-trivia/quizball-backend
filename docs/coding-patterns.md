# QuizBall Backend — Coding Standards (Node.js + Express + TypeScript)

This document defines the rules for writing backend code in this repo.
Goal: clean, consistent, type-safe, testable code without unnecessary complexity.

---

## 1) Core Principles

### Clean Code
- Functions do **one thing**.
- Prefer readable code over clever code.
- Name things clearly (avoid abbreviations).
- Keep files small and focused.

### DRY (Don’t Repeat Yourself)
- Extract repeated logic into:
  - shared middleware (auth, request-id, validation)
  - shared utilities (safe parsing, formatting)
  - shared domain services (UsersService)

### KISS (Keep It Simple)
- No over-architecting.
- Start with simple patterns; only add abstraction when there is repeated pain.

### Type Safety First
- Use TypeScript strictly.
- No `any` unless absolutely necessary.
- Validate all untrusted input (requests, env vars, external APIs).

---

## 2) Project Architecture

We use a layered approach:

- **Routes**: wire endpoints + attach middleware. No business logic.
- **Controllers**: translate HTTP to service calls and return response DTOs.
- **Services (Use-cases)**: business logic. No Express types. No `req`/`res`.
- **Repositories**: DB queries only. No business rules.
- **Providers**: external APIs (Supabase, Redis, S3, etc.)
- **Core**: config, errors, logging, request id.

Rule: dependencies flow inward.
Routes → Controllers → Services → Repositories/Providers.

### Realtime (WebSocket) Architecture

We follow the same layering for Socket.IO:

- **Socket Handlers**: validate payloads (Zod) and delegate to realtime services. No business logic.
- **Realtime Services**: socket-specific use-cases. Orchestrate domain logic, call repos/services, emit socket events.
- **Repositories/Providers**: unchanged (DB + external integrations).

Rule: dependencies flow inward.
Handlers → Realtime Services → Repositories/Providers.

---

## 3) Naming Conventions

- Files: `kebab-case.ts` or `camelCase.ts` (pick one and stick to it). Recommended: kebab-case.
- Classes: `PascalCase` (e.g., `UsersService`)
- Functions/vars: `camelCase` (e.g., `getOrCreateUserFromIdentity`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `REQUEST_ID_HEADER`)
- Zod schemas end with `.schema.ts`

---

## 4) API Versioning & Routing

- All endpoints live under `/api/v1`.
- Routes:
  - `/api/v1/auth/*`
  - `/api/v1/users/*`

Routes should only:
- validate input (Zod middleware)
- call controller
- return response

---

## 5) Input Validation (Zod)

### Rule
Every request must be validated.
- `params`, `query`, and `body` all validated via Zod.
- Don’t trust the client.

### Pattern
- Define schemas in `src/api/schemas/*`.
- Use a `validate()` middleware.

---

## 6) Error Handling Contract

### Rule
Never `throw` raw errors to the client.

We use typed errors extending `AppError` and a global error handler.

Response schema:
```json
{
  "code": "AUTHENTICATION_ERROR",
  "message": "Authentication failed",
  "details": null,
  "request_id": "..."
}
