import type { RawResponse } from "../http/client.ts";
import { KeaHttpError } from "../http/errors.ts";

export type Envelope =
  | { readonly kind: "ok"; readonly arguments: unknown; readonly text: string | undefined }
  | { readonly kind: "unsupported"; readonly text: string | undefined }
  | { readonly kind: "empty"; readonly arguments: unknown; readonly text: string | undefined }
  | { readonly kind: "api-error"; readonly result: number; readonly text: string | undefined }
  | { readonly kind: "auth" }
  | { readonly kind: "http-error"; readonly statusCode: number }
  | { readonly kind: "malformed"; readonly detail: string };

// Kea's error text can quote configuration, so it is bounded before it can
// reach a log line.
const MAX_TEXT_LENGTH = 200;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// D§3.2.3 and D§3.2.4. A normal answer is a one-element array; only an
// authentication or authorisation failure is a bare object. Anything else is
// malformed rather than guessed at.
export function classify(response: RawResponse): Envelope {
  const { statusCode, body } = response;
  if (statusCode === 401 || statusCode === 403) return { kind: "auth" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (statusCode < 200 || statusCode >= 300) return { kind: "http-error", statusCode };
    return { kind: "malformed", detail: "body is not JSON" };
  }

  if (isRecord(parsed) && (parsed.result === 401 || parsed.result === 403)) return { kind: "auth" };
  if (statusCode < 200 || statusCode >= 300) return { kind: "http-error", statusCode };

  if (!Array.isArray(parsed)) return { kind: "malformed", detail: "response is not an array" };
  if (parsed.length !== 1) {
    return {
      kind: "malformed",
      detail: `response array has ${parsed.length} elements, expected 1`,
    };
  }
  const [answer] = parsed;
  if (!isRecord(answer) || !Number.isInteger(answer.result)) {
    return { kind: "malformed", detail: "response element has no integer result" };
  }

  const text = boundedText(answer.text);
  switch (answer.result) {
    case 0:
      return { kind: "ok", arguments: answer.arguments, text };
    case 2:
      return { kind: "unsupported", text };
    case 3:
      return { kind: "empty", arguments: answer.arguments, text };
    default:
      return { kind: "api-error", result: answer.result as number, text };
  }
}

// For callers that need a successful answer and treat everything else as a
// failed call. Unsupported and empty are not errors in general (D§3.2.4);
// a caller that can accept them inspects classify() itself.
export function toError(command: string, envelope: Envelope): KeaHttpError {
  switch (envelope.kind) {
    case "auth":
      return new KeaHttpError("auth", `${command}: credential rejected`);
    case "http-error":
      return new KeaHttpError(
        envelope.statusCode >= 400 ? "http_4xx" : "unknown",
        `${command}: HTTP ${envelope.statusCode}`,
      );
    case "malformed":
      return new KeaHttpError("parse", `${command}: ${envelope.detail}`);
    case "api-error":
      return new KeaHttpError(
        "api_error",
        `${command}: result ${envelope.result}${envelope.text === undefined ? "" : ` (${envelope.text})`}`,
      );
    case "unsupported":
      return new KeaHttpError("api_error", `${command}: command not supported by this daemon`);
    case "empty":
      return new KeaHttpError("api_error", `${command}: empty result`);
    case "ok":
      return new KeaHttpError("unknown", `${command}: toError called on a successful answer`);
  }
}

export function expectOk(command: string, response: RawResponse): unknown {
  const envelope = classify(response);
  if (envelope.kind !== "ok") throw toError(command, envelope);
  return envelope.arguments;
}
