---
"relayrunner": minor
---

`relayrunner connect` tells you when npm has a newer `relayrunner`, with the command that updates it (`npx relayrunner@latest connect`, or `npm install --global relayrunner@latest` for a global install). It asks npm at most once a day, in the background, so it never slows down connecting, and a `connect` left running checks again each day. It only checks when someone is at the terminal and not in CI. `connect` also tells the gateway which CLI version the machine runs, and `relayrunner --version` prints it.
