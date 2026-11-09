# @relayrunner/machine-protocol

The messages a connected machine and the gateway exchange over the machine WebSocket. The API's `MachineLink` Durable Object holds one end, and `relayrunner connect` holds the other.

Used by [`apps/api`](../../apps/api) and [`apps/cli`](../../apps/cli). The CLI bundles it into its npm package.

## Messages

Every message is a JSON text frame carrying the protocol version in `v`.

| Direction         | Type     | What it says                                                           |
| ----------------- | -------- | ---------------------------------------------------------------------- |
| machine → gateway | `hello`  | The machine is ready: its OS, architecture, runner version and device. |
| machine → gateway | `status` | The machine is idle or busy.                                           |
| machine → gateway | `job`    | A job the gateway sent started, finished or failed.                    |
| gateway → machine | `run`    | Run a job: a one-job (JIT) runner config for a route.                  |
| gateway → machine | `paused` | The machine was paused or resumed from the dashboard.                  |
| gateway → machine | `error`  | A version mismatch or a message the gateway couldn't read.             |

`parseMachineMessage` and `parseGatewayMessage` validate a frame with Zod, and `encodeMessage` writes one. Auth isn't part of the protocol: the machine token goes on the WebSocket upgrade request.

## Versioning

Either side rejects a message whose version it doesn't speak, so a gateway deploy and an older CLI fail loudly instead of misreading each other. Bump `PROTOCOL_VERSION` for any change an older peer would misread. Adding an optional field doesn't need a bump.
