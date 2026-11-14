import { isErrorBody } from "@relayrunner/errors";

/**
 * Why a request to the gateway failed, for "Couldn't …: <reason>.": the API's message and error
 * code when it sent one (@relayrunner/errors), else the HTTP status.
 */
export function failureReason(server: string, response: Response, body: unknown) {
  if (!isErrorBody(body)) return `${server} answered HTTP ${response.status}`;
  return `${body.error.message.replace(/\.$/, "")} (${body.error.code})`;
}
