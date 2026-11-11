// This CLI's own version, from its package.json. tsdown bundles the JSON into dist/cli.js.
import pkg from "./package.json" with { type: "json" };

export const cliVersion: string = pkg.version;
