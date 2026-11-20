/**
 * The search params of the panels that open over any workspace page: a runner's (`runner`) and a
 * workflow's (`wf`, its repo and name), each with its range when that isn't the default. The
 * workflow's param isn't `workflow`, which Performance already uses for its own job detail.
 */
export type PanelSearch = {
  runner?: string;
  runnerRange?: string;
  wf?: string;
  wfRange?: string;
};

/** Every panel closed: spread into a search before opening one, so one panel shows at a time. */
export const CLOSED_PANELS: { [K in keyof PanelSearch]: undefined } = {
  runner: undefined,
  runnerRange: undefined,
  wf: undefined,
  wfRange: undefined,
};
