// Readers for a job message's `contextData`: its expression contexts (github, inputs, ...) as the
// runner's PipelineContextData JSON. A dictionary is {t: 2, d: [{k, v}]}, a string is a bare JSON
// string or {s}, and a number is {t: 4, n}.

/** A top-level context, such as `github` or `inputs`, or null when it's missing. */
export function context(contextData: unknown, name: string): Map<string, unknown> | null {
  return dictionary(isRecord(contextData) ? contextData[name] : undefined);
}

export function dictionary(value: unknown): Map<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.d)) return null;
  const entries = new Map<string, unknown>();
  for (const entry of value.d)
    if (isRecord(entry) && typeof entry.k === "string") entries.set(entry.k, entry.v);
  return entries;
}

export function scalar(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (isRecord(value)) {
    if (typeof value.s === "string") return value.s;
    if (typeof value.n === "number") return value.n;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
