import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request context stored in AsyncLocalStorage.
 */
interface RequestContext {
  requestId: string;
}

/**
 * AsyncLocalStorage instance for request context.
 * Similar to Python's ContextVar.
 */
const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with request context.
 */
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Get the current request ID from context.
 * Returns null if not in a request context.
 */
export function getRequestId(): string | null {
  const store = asyncLocalStorage.getStore();
  return store?.requestId ?? null;
}

/**
 * Get the current request context.
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}
