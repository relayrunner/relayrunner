/**
 * Custom trace spans (Workers tracing, `observability.traces` in wrangler.jsonc). The platform
 * already traces every fetch, D1 query, queue send and Durable Object call; these name the work
 * around them, such as one webhook delivery or one routing decision, and tag it with ids to search
 * by. Traces go to the Workers dashboard and to any OpenTelemetry destination the config lists
 * (docs/observability.md).
 */
import { tracing } from "cloudflare:workers";

export type SpanAttributes = Record<string, string | number | boolean | null | undefined>;

/**
 * Run `fn` inside a span named `name`. A throw marks the span as an error, records the exception
 * and rethrows.
 */
export function traced<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(name, async (span) => {
    span.setAttributes(defined(attributes));
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

/** Add attributes to the active span: the innermost `traced` span, or the invocation's own. */
export function annotate(attributes: SpanAttributes) {
  tracing.getActiveSpan()?.setAttributes(defined(attributes));
}

/** Rename the active span, such as a request's root span once its route is known. */
export function renameSpan(name: string) {
  tracing.getActiveSpan()?.updateName(name);
}

// Spans take undefined (skipped) but not null, which the GitHub payloads use for "none".
function defined(attributes: SpanAttributes) {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = value ?? undefined;
  return out;
}
