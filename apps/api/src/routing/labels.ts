// The labels that send a job through RelayRunner, shared by routing, the reports and the webhook
// consumer.

/** The `runs-on` label that routes a job through RelayRunner. */
export const RELAYRUNNER_LABEL = "relayrunner";

// GitHub matches runs-on labels case-insensitively, so `RelayRunner` counts too.
export function usesRelayRunner(labels: string[]) {
  return labels.some((label) => label.toLowerCase() === RELAYRUNNER_LABEL);
}
