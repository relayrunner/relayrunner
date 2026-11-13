/**
 * The agent skills in skills/ at the repo root, served over MCP with the Skills extension
 * (SEP-2640): clients that support it list them with skills/list and read each file at
 * skill://<skill>/<file>. The same files install with `npx skills add relayrunner/relayrunner`.
 * Wrangler bundles each file as text (the Text rule in wrangler.jsonc), so a skill change ships
 * with the next deploy of this Worker.
 */
import {
  memorySkillFiles,
  type SkillCatalog,
  SkillsExtension,
} from "@modelcontextprotocol/server/ext/skills";
import relayrunner from "../../../skills/relayrunner/SKILL.md";
import ciInsights from "../../../skills/relayrunner-ci-insights/SKILL.md";
import routeJobs from "../../../skills/relayrunner-route-jobs/SKILL.md";
import skippedJobs from "../../../skills/relayrunner-route-jobs/references/skipped-jobs.md";

/** Every file under skills/, by its path there. skills.test.ts checks none is missing. */
export const SKILL_FILES: Record<string, string> = {
  "relayrunner/SKILL.md": relayrunner,
  "relayrunner-ci-insights/SKILL.md": ciInsights,
  "relayrunner-route-jobs/SKILL.md": routeJobs,
  "relayrunner-route-jobs/references/skipped-jobs.md": skippedJobs,
};

let catalog: Promise<SkillCatalog> | undefined;

// Built on the first request (hashing each file once per isolate), since Workers don't allow
// async work at startup.
export function skillCatalog() {
  catalog ??= SkillsExtension.load(memorySkillFiles(SKILL_FILES), {
    strict: true,
    // The files change only when this Worker deploys.
    cacheHint: { ttlMs: 60 * 60 * 1000, cacheScope: "public" },
  });
  return catalog;
}
