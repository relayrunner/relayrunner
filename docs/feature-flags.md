# Feature flags

Feature flags let you merge and deploy a feature before people can see it. The flags live in the
"relayrunner" app in [Cloudflare Flagship](https://developers.cloudflare.com/flagship/), on the
RelayRunner account (app id `95c8465d-fccc-4ab0-aca0-228994c84e52`). You turn a flag on for
yourself, for a workspace, for a percentage of people or for everyone in the Cloudflare dashboard,
and the change reaches every Worker within about 30 seconds without a deploy.

Only the API evaluates flags, through the `FLAGS` binding in `apps/api/wrangler.jsonc`. The
dashboard reads them from `GET /api/flags`, because reading Flagship from the browser would need a
Cloudflare API token in the page.

## Add a flag

1. Add its key to `FLAG_KEYS` in `packages/api-types/src/flags.ts`. Keys use letters, numbers and
   hyphens, such as `provider-evaluations`.
2. Create a boolean flag with the same key in the Flagship app, with `off` (false) as its default
   variant. A flag that doesn't exist in Flagship yet reads as off, so you can merge the code
   first.
3. Guard the feature in the API and in the dashboard, as below.

Every check falls back to off: with no binding, for a key Flagship doesn't have, and when
evaluation fails.

### In the API

```ts
import { isFlagOn, requireFlag } from "../flags.ts";

// A whole router: anyone without the flag gets 404, as if the routes didn't exist.
export const evaluationRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace, requireFlag("provider-evaluations"))
  .get("/", …);

// Or one branch inside a handler.
if (await isFlagOn(c, "provider-evaluations")) { … }
```

Run `requireFlag` after `requireUser` and `requireWorkspace`, so targeting rules see who is asking.
Each flag is evaluated once per request.

### In the dashboard

The workspace layout loads the flags with the workspace, so pages check them synchronously:

```tsx
import { Flag, requireFlagRoute, useFlag } from "@/lib/flags";

const on = useFlag("provider-evaluations");

<Flag name="provider-evaluations">
  <Button>Evaluate</Button>
</Flag>;

// A whole page: anyone without the flag lands on Runners.
export const Route = createFileRoute("/_authed/_workspace/providers/$provider_/evaluate")({
  beforeLoad: requireFlagRoute("provider-evaluations"),
  …
});
```

Hiding UI isn't protection on its own, so guard the feature's API routes too. In the dev preview
without sign-in (`VITE_AUTH_DISABLED=true`), every flag is on.

## Targeting

Every evaluation sends this context, which Flagship's targeting rules can match on:

| Attribute       | Value                                                     |
| --------------- | --------------------------------------------------------- |
| `targetingKey`  | The user's id. Percentage rollouts bucket on it.          |
| `userId`        | The user's id.                                            |
| `role`          | `operator` for operators, and left out for everyone else. |
| `workspaceId`   | The active workspace's id.                                |
| `workspaceSlug` | The workspace's GitHub account login, such as `acme`.     |

To turn a flag on for operators only (the people who see Admin, `user.role` in D1), add a rule
`role equals "operator"` that serves `on`, and keep the default variant off. To try a feature
yourself alone, use `userId equals "<your user id>"` instead.
Don't add personal data such as emails to the context.

## Local development

`wrangler dev` evaluates flags against a local store that starts empty, so every flag is off.
Copy the real flags down with:

```sh
pnpm --filter @relayrunner/api flags:pull
```

To change a flag only on your machine, use `npx wrangler flagship flags … --local` from
`apps/api`. Tests run without the binding, so every flag is off unless a test passes a stub as
`FLAGS` (see `apps/api/src/flags.test.ts`).

## Retire a flag

Once a feature is on for everyone and working:

1. Remove the key from `FLAG_KEYS`. TypeScript then points at every remaining check.
2. Delete the checks, keeping the code path for "on", and deploy.
3. Delete the flag in Flagship.
