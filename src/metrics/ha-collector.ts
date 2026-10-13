import { parseHighAvailability } from "../api/ha.ts";
import { reasonOfError } from "../http/errors.ts";
import { applyHa, createHaMetrics, type HaMetrics } from "./ha-metrics.ts";
import type { TargetMetricsBase } from "./registry.ts";

export interface HaCollectorOptions {
  readonly base: TargetMetricsBase;
  readonly warn: (message: string) => void;
}

// D§5.2. Reads the high-availability section of the status-get response the
// status collector already fetched, so HA adds no upstream call. It is only
// applied after a successful status-get: on a failed cycle every HA series
// keeps its last value, like every other series (D§5.8).
export class HaCollector {
  readonly #base: TargetMetricsBase;
  readonly #metrics: HaMetrics;
  readonly #warn: (message: string) => void;
  #failing = false;

  constructor(options: HaCollectorOptions) {
    this.#base = options.base;
    this.#metrics = createHaMetrics(options.base);
    this.#warn = options.warn;
  }

  apply(highAvailability: unknown): void {
    try {
      applyHa(this.#metrics, this.#base, parseHighAvailability(highAvailability));
      this.#failing = false;
    } catch (error) {
      this.#base.collectorSuccess.labels({ collector: "ha" }).set(0);
      if (reasonOfError(error) === "parse") this.#base.parseErrors.inc({ group: "ha" });
      if (!this.#failing) {
        const message = error instanceof Error ? error.message : String(error);
        this.#warn(`ha collector failed (${reasonOfError(error)}): ${message}`);
        this.#failing = true;
      }
    }
  }
}
