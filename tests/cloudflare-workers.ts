// What tests get for `cloudflare:workers`, which only exists inside workerd (vitest.config.ts).
// Only what the code uses; a test that needs more can still vi.mock the module.

export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

const span = {
  setAttribute: () => span,
  setAttributes: () => span,
  setStatus: () => span,
  updateName: () => span,
  recordException() {},
};

export const tracing = {
  enterSpan: (_name: string, callback: (s: typeof span) => unknown) => callback(span),
  getActiveSpan: () => span,
};

// The Worker's bindings at module scope. Tests pass their own env to handlers instead.
export const env = {};
