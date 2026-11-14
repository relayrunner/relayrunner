import { describeError, isErrorBody, parseError } from "@relayrunner/errors";

/**
 * Why a request to the gateway failed, for "Couldn't …: <reason>.": the API's message and error
 * code when it sent one (@relayrunner/errors), else the HTTP status.
 */
export function failureReason(server: string, status: number, body: unknown) {
  return isErrorBody(body)
    ? describeError(parseError(body, status))
    : `${server} answered HTTP ${status}`;
}
