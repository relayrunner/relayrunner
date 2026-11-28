// Feature flags, evaluated by Cloudflare Flagship (apps/api/src/flags.ts, docs/feature-flags.md).
// Every key the API or the dashboard checks is listed here, so a typo or a flag that was retired
// is a type error. Add a key when you ship code behind a new flag, and remove it (with every use)
// once the feature is released for everyone.
//
// Each flag is a boolean in the Flagship app, and reads as off when Flagship can't answer.
export const FLAG_KEYS = [] as const satisfies readonly string[];

export type FlagKey = (typeof FLAG_KEYS)[number];

/** Every flag's value for the signed-in user in their active workspace (GET /api/flags). */
export type Flags = Record<FlagKey, boolean>;
