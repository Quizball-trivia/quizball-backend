import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('quizball-backend');

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function addSpanAttributes(span: Span, attributes: Attributes): void {
  span.setAttributes(attributes);
}

export function setSpanAttributeIfDefined(
  span: Span,
  key: string,
  value: string | number | boolean | null | undefined
): void {
  if (value === undefined || value === null) return;
  span.setAttribute(key, value);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const normalized = toError(error);
      span.recordException(normalized);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: normalized.message,
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
