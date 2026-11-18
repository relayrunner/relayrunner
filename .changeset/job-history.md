---
"relayrunner": minor
---

`connect` keeps a history of the jobs it runs in `~/.relayrunner/history.jsonl`, and `relayrunner history` lists them with each one's result and time. When it starts a job it now names it, and with `--events` the `run` event says which job it is and how long it usually takes on this machine.
