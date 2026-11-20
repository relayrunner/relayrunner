/** A workflow, as the panel's `?wf=` names it: its repo and name. */
export type WorkflowRef = { repository: string; workflow: string };

// A repo's full name never has a colon, so the first one ends it and the rest is the name.
export const workflowParam = ({ repository, workflow }: WorkflowRef) => `${repository}:${workflow}`;

export function parseWorkflowParam(value: string | undefined): WorkflowRef | undefined {
  const at = value?.indexOf(":") ?? -1;
  if (!value || at < 1 || at === value.length - 1) return undefined;
  return { repository: value.slice(0, at), workflow: value.slice(at + 1) };
}
