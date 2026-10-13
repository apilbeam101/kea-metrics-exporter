// D§5.9's bounded reason set for kea_exporter_poll_errors_total{reason}.
// `api_error` exists because a Kea failure is an HTTP 200 carrying a non-zero
// result code (D§3.2.4), which a status-code-only taxonomy cannot express.
export type PollErrorReason =
  | "auth"
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "too_large"
  | "parse"
  | "api_error"
  | "unknown";

export class KeaHttpError extends Error {
  override readonly name = "KeaHttpError";
  readonly reason: PollErrorReason;

  constructor(reason: PollErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

// A TypeError reaching a collector's catch is a body-shape mismatch that
// slipped past a parser's own explicit "parse" throws, so it is a parse
// failure rather than an unknown one.
export function reasonOfError(error: unknown): PollErrorReason {
  if (error instanceof KeaHttpError) return error.reason;
  if (error instanceof TypeError) return "parse";
  return "unknown";
}
