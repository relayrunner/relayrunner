/**
 * lint-staged config, run by the Husky pre-commit hook.
 *
 * Files under an `.oxfmtrc.json` ignorePattern are filtered out first: handing oxfmt a list
 * that is entirely ignored makes it exit non-zero ("Expected at least one target file").
 */

import path from "node:path";

// Repo-relative prefixes from `.oxfmtrc.json` ignorePatterns.
// The vendored security-audit skill must stay byte-identical to skills-lock.json.
const VENDORED_SKILL_DIRS = [".agents/", ".claude/skills/security-audit/"];
const OXFMT_IGNORED_DIRS = [
  "apps/api/migrations/meta/",
  "apps/site/.impeccable/",
  ...VENDORED_SKILL_DIRS,
];

const relative = (file) => path.relative(process.cwd(), file);

const isIgnored = (file) => {
  const rel = relative(file);
  return (
    OXFMT_IGNORED_DIRS.some((dir) => rel.startsWith(dir)) ||
    rel.endsWith(".d.ts") ||
    rel.endsWith(".gen.ts")
  );
};

const oxlintCommand = (stagedFiles) => {
  const lintable = stagedFiles.filter(
    (f) => !VENDORED_SKILL_DIRS.some((dir) => relative(f).startsWith(dir)),
  );
  return lintable.length > 0
    ? [`oxlint --deny-warnings --no-error-on-unmatched-pattern ${lintable.join(" ")}`]
    : [];
};

const oxfmtCommand = (stagedFiles) => {
  const formattable = stagedFiles.filter((f) => !isIgnored(f));
  return formattable.length > 0
    ? [`oxfmt --no-error-on-unmatched-pattern --write ${formattable.join(" ")}`]
    : [];
};

export default {
  "*.{js,jsx,ts,tsx,mjs,cjs}": (stagedFiles) => [
    ...oxlintCommand(stagedFiles),
    ...oxfmtCommand(stagedFiles),
  ],
  "*.{json,jsonc,md,yml,yaml,css,html,toml}": oxfmtCommand,
};
