import { ERRORS } from "@relayrunner/errors";

/** Every API error code, A to Z, for the Errors page (<ErrorTable />). */
export const ERROR_ROWS = Object.entries(ERRORS)
  .map(([code, { status, message }]) => ({ code, status, message }))
  .sort((a, b) => a.code.localeCompare(b.code));

/** <ErrorTable /> as Markdown. */
export function errorTableMarkdown(): string {
  return [
    "| Code | Status | Message |",
    "| --- | --- | --- |",
    ...ERROR_ROWS.map(({ code, status, message }) => `| \`${code}\` | ${status} | ${message} |`),
  ].join("\n");
}
