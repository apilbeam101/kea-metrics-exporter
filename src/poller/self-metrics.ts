import { Counter, Gauge, Histogram, type Registry } from "@prometheus-io/client";
import type { UpstreamAttemptOutcome } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { AbsentUntilSetGauge } from "../metrics/absent-gauge.ts";
import type { CycleResult } from "./target-registry.ts";

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

// D§5.9: one target's view of its own polling. Recorded from the poll path
// only; the two computed gauges (cache age, series count) are evaluated at
// render time, which is what makes them honest about the present.
export class SelfMetrics {
  readonly #clock: Clock;
  readonly #lastSuccess: AbsentUntilSetGauge;
  readonly #cacheAge: AbsentUntilSetGauge;
  readonly #pollTotal: Counter;
  readonly #pollErrors: Counter<"reason">;
  readonly #pollDuration: Histogram;
  readonly #upstreamRequests: Counter<"command" | "status_code">;
  readonly #upstreamDuration: Histogram<"command">;
  readonly #upstreamBytes: Gauge<"command">;
  #lastSuccessElapsedMs: number | undefined;

  constructor(registry: Registry, clock: Clock, tlsVerificationDisabled: boolean) {
    this.#clock = clock;
    const registers = [registry];

    this.#lastSuccess = new AbsentUntilSetGauge(
      registry,
      "kea_exporter_last_successful_poll_timestamp_seconds",
      "Wall-clock time of the last cycle in which status-get succeeded; absent until the first",
    );
    // Computed from the monotonic clock at render time, so it keeps growing
    // while a target is down instead of freezing with the cache.
    this.#cacheAge = new AbsentUntilSetGauge(
      registry,
      "kea_exporter_cache_age_seconds",
      "Seconds since the last successful cycle, computed at scrape time; absent until the first",
      () =>
        this.#lastSuccessElapsedMs === undefined
          ? 0
          : (this.#clock.elapsed() - this.#lastSuccessElapsedMs) / 1000,
    );
    this.#pollTotal = new Counter({
      name: "kea_exporter_poll_total",
      help: "Poll cycles run against this target",
      registers,
    });
    this.#pollErrors = new Counter({
      name: "kea_exporter_poll_errors_total",
      help: "Failed commands, by poll error reason",
      labelNames: ["reason"],
      registers,
    });
    this.#pollDuration = new Histogram({
      name: "kea_exporter_poll_duration_seconds",
      help: "Duration of a whole poll cycle",
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#upstreamRequests = new Counter({
      name: "kea_exporter_upstream_requests_total",
      help: "HTTP attempts to Kea, by command and HTTP status, or timeout or network when there was no response",
      labelNames: ["command", "status_code"],
      registers,
    });
    this.#upstreamDuration = new Histogram({
      name: "kea_exporter_upstream_request_duration_seconds",
      help: "Duration of one HTTP attempt to Kea",
      labelNames: ["command"],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#upstreamBytes = new Gauge({
      name: "kea_exporter_upstream_response_bytes",
      help: "Size of the last response body received for each command",
      labelNames: ["command"],
      registers,
    });
    new Gauge({
      name: "kea_exporter_tls_verification_disabled",
      help: "1 when TLS certificate verification is disabled for this target",
      registers,
    }).set(tlsVerificationDisabled ? 1 : 0);

    // N7's tripwire: the number of series this target renders, counted at
    // render time across every other family in the registry.
    const series: Gauge = new Gauge({
      name: "kea_exporter_series",
      help: "Series rendered for this target, including this one",
      registers,
      collect: async () => {
        let total = 1;
        for (const { name } of registry.getMetricsAsArray()) {
          const metric = registry.getSingleMetric(name);
          if (metric === undefined || name === "kea_exporter_series") continue;
          total += (await metric.get()).values.length;
        }
        series.set(total);
      },
    });
  }

  recordAttempt(outcome: UpstreamAttemptOutcome): void {
    const { command } = outcome;
    const statusCode = "statusCode" in outcome ? String(outcome.statusCode) : outcome.reason;
    this.#upstreamRequests.inc({ command, status_code: statusCode });
    this.#upstreamDuration.observe({ command }, outcome.durationMs / 1000);
    if ("bytes" in outcome) this.#upstreamBytes.set({ command }, outcome.bytes);
  }

  recordCycle(result: CycleResult, durationMs: number, nowMs: number): void {
    this.#pollTotal.inc();
    this.#pollDuration.observe(durationMs / 1000);
    for (const reason of result.errors) this.#pollErrors.inc({ reason });
    if (result.up) {
      this.#lastSuccess.set(nowMs / 1000);
      this.#lastSuccessElapsedMs = this.#clock.elapsed();
      this.#cacheAge.ensurePresent();
    }
  }
}
