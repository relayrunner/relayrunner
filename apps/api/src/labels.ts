// Job labels RelayRunner gives meaning to. A module of its own, with no imports, so modules on
// both sides of an import cycle can read them while they load.

/** The `runs-on` label that routes a job through RelayRunner. */
export const RELAYRUNNER_LABEL = "relayrunner";

/** The start of the label a route gives a job (`rr-<route id>`). */
export const ROUTE_LABEL_PREFIX = "rr-";
