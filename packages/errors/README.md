# @relayrunner/errors

Every error code the API can return, and the one shape it returns them in. Used by [`apps/api`](../../apps/api) (which throws them), [`apps/web`](../../apps/web), [`apps/agents`](../../apps/agents) and [`apps/cli`](../../apps/cli) (which read them), and [`apps/site`](../../apps/site) (the [Errors](https://relayrunner.app/docs/reference/errors) page and the OpenAPI enum).

## What's in it

- **`ERRORS`**: each code in SCREAMING_SNAKE_CASE, with its HTTP status and a default message. A code never changes once it ships; its message can.
- **`AppError`**: `throw new AppError("PROVIDER_EXISTS")` in an API route, optionally with `message`, `details`, `retryAfter` (sent as `Retry-After`) or `cause`. The API's `onError` answers with the code's status and the body below; anything else thrown becomes `INTERNAL_ERROR`, logged but not shown.
- **`parseError`** and **`isErrorBody`**: read a response body back. `parseError` never throws, and keeps a code newer than the reader.
- **`describeError`**: an error in one line for an agent or a terminal, such as `Not found (NOT_FOUND)`.

Every non-2xx response has this body:

```json
{ "error": { "code": "NOT_FOUND", "message": "Not found.", "details": {} } }
```

`details` is optional and differs per code.

## Adding a code

Add it to `ERRORS` before returning it. Name feature-specific codes `DOMAIN_FAILURE` (`PROVIDER_EXISTS`, `GITHUB_RATE_LIMITED`) so the code alone says what broke. Write the message as a plain sentence a person or an agent can act on.

Two kinds of code live elsewhere on purpose: the OAuth device-flow codes (`authorization_pending`, `slow_down` and so on), which RFC 8628 names, and the Router's skip reasons in `@relayrunner/activity`, which are saved with each route decision rather than returned as errors.
