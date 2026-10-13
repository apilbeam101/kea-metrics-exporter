import { type Dispatcher, request as undiciRequest } from "undici";
import type { Secret } from "../config/secret.ts";
import type { Clock } from "./clock.ts";
import { type AllowedCommand, assertCommandAllowed } from "./command-allowlist.ts";
import { KeaHttpError, type PollErrorReason } from "./errors.ts";
import { withBudgetedRetry } from "./retry.ts";

export interface RawResponse {
  readonly statusCode: number;
  readonly body: string;
}

// Fired once per real HTTP attempt, retried ones included, for D§5.9's
// upstream_requests_total{command,status_code} and its duration histogram.
// An attempt that never got a response carries a reason instead of a status
// code; both are bounded label values.
export type UpstreamAttemptOutcome =
  | {
      readonly command: AllowedCommand;
      readonly durationMs: number;
      readonly statusCode: number;
      // Body bytes received: the whole body, or as far as an over-size one got.
      readonly bytes: number;
    }
  | {
      readonly command: AllowedCommand;
      readonly durationMs: number;
      readonly reason: PollErrorReason;
    };

export type OnUpstreamAttempt = (outcome: UpstreamAttemptOutcome) => void;

export interface KeaClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: Secret;
  readonly dispatcher: Dispatcher;
  readonly clock: Clock;
  readonly budgetMs: number;
  readonly maxResponseBytes: number;
  readonly onUpstreamAttempt?: OnUpstreamAttempt;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof KeaHttpError &&
    (error.reason === "timeout" || error.reason === "network" || error.reason === "http_5xx")
  );
}

// D§6.3: the only operation is command(name). The body is serialised from
// the allowlisted name alone, with no way to attach arguments, and always
// POSTed to the fixed path "/". Redirects are never followed: undici's
// request() installs no redirect interceptor unless one is composed in.
export class KeaClient {
  readonly #url: string;
  readonly #username: string;
  readonly #password: Secret;
  readonly #dispatcher: Dispatcher;
  readonly #clock: Clock;
  readonly #budgetMs: number;
  readonly #maxResponseBytes: number;
  readonly #onUpstreamAttempt: OnUpstreamAttempt | undefined;

  constructor(options: KeaClientOptions) {
    // The base URL is an opaque prefix (D§6.1): appended to, never parsed, so
    // a reverse-proxy path prefix survives.
    this.#url = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.#username = options.username;
    this.#password = options.password;
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock;
    this.#budgetMs = options.budgetMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#onUpstreamAttempt = options.onUpstreamAttempt;
  }

  async command(name: AllowedCommand): Promise<RawResponse> {
    assertCommandAllowed(name);
    const body = JSON.stringify({ command: name });

    return withBudgetedRetry(
      { clock: this.#clock, budgetMs: this.#budgetMs, isRetryable },
      (remainingMs) => this.#attempt(name, body, remainingMs),
    );
  }

  // Built per attempt and never stored, so no logged object ever holds it.
  #authorization(): string {
    const credentials = `${this.#username}:${this.#password.reveal()}`;
    return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }

  // Reading the body sits inside the same try as the request: a reset or
  // stall mid-body is as much a network or timeout failure as one during
  // connect.
  async #attempt(name: AllowedCommand, body: string, remainingMs: number): Promise<RawResponse> {
    const startedAt = this.#clock.elapsed();
    let statusCode: number | undefined;
    let received = 0;
    let result: RawResponse;
    try {
      // Clamped: a timer overshoot can leave the budget slightly negative,
      // and AbortSignal.timeout throws on a negative value. 0 aborts at once,
      // which is the honest outcome for a spent budget.
      const response = await undiciRequest(this.#url, {
        method: "POST",
        dispatcher: this.#dispatcher,
        headers: {
          authorization: this.#authorization(),
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(Math.max(remainingMs, 0)),
      });
      statusCode = response.statusCode;

      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        received += (chunk as Buffer).length;
        if (received > this.#maxResponseBytes) {
          response.body.destroy();
          throw new KeaHttpError(
            "too_large",
            `${name} response exceeded ${this.#maxResponseBytes} bytes`,
          );
        }
        chunks.push(chunk as Buffer);
      }
      result = { statusCode, body: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      const durationMs = this.#clock.elapsed() - startedAt;
      // An over-size body still got a response, so its attempt is labelled
      // with the real status code, keeping status_code to numbers plus
      // timeout and network (D§5.9).
      if (error instanceof KeaHttpError && statusCode !== undefined) {
        this.#onUpstreamAttempt?.({ command: name, durationMs, statusCode, bytes: received });
        throw error;
      }
      const reason: PollErrorReason =
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
      this.#onUpstreamAttempt?.({ command: name, durationMs, reason });
      throw new KeaHttpError(
        reason,
        `${name} ${reason === "timeout" ? "timed out" : "request failed"}`,
        { cause: error },
      );
    }

    const durationMs = this.#clock.elapsed() - startedAt;
    this.#onUpstreamAttempt?.({
      command: name,
      durationMs,
      statusCode: result.statusCode,
      bytes: received,
    });

    if (result.statusCode >= 500) {
      throw new KeaHttpError("http_5xx", `${name} returned HTTP ${result.statusCode}`);
    }
    return result;
  }
}
