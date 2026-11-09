# @relayrunner/email

Templates for RelayRunner's transactional emails. Each one renders to a `{ subject, text, html }` object; sending lives in the API (`apps/api/src/email.ts`), which delivers them with Cloudflare Email Sending.

| Template                      | Sent when                                         |
| ----------------------------- | ------------------------------------------------- |
| `renderWelcomeEmail`          | A user signs up.                                  |
| `renderInviteEmail`           | An owner invites someone to a workspace.          |
| `renderMachineConnectedEmail` | A new machine is connected to a workspace.        |
| `renderDeadLetterAlertEmail`  | Webhook dead letters pile up (sent to operators). |

## Writing a template

Every template wraps its content in `renderEmailCard` from `src/card.ts`, the shared shell with the wordmark, an eyebrow label, a title, body paragraphs and an optional button. `escapeHtml`, `strong`, `code` and `link` build inline HTML safely.

The card's colors follow the dashboard's tokens in `apps/web/src/styles.css`, so move them together. Web fonts don't load in most mail clients, so the fallback font stacks are the design.

`src/templates.test.ts` renders each template; add a case for a new one.
