import { Counter, Gauge, type Registry } from "@prometheus-io/client";
import type { StateSetClassification } from "./state-set.ts";

// The families every collector of one target writes to. A Registry rejects a
// second registration under the same name, so these are created once per
// target and handed to each collector rather than owned by any one of them.
export interface TargetMetricsBase {
  readonly registry: Registry;
  readonly collectorSuccess: Gauge<"collector">;
  readonly unknownEnum: Counter<"metric" | "value">;
  readonly parseErrors: Counter<"group">;
}

export function createTargetMetricsBase(registry: Registry): TargetMetricsBase {
  return {
    registry,
    collectorSuccess: new Gauge<"collector">({
      name: "kea_collector_success",
      help: "Per-collector outcome of the last poll cycle: 1 success, 0 failure",
      labelNames: ["collector"],
      registers: [registry],
    }),
    unknownEnum: new Counter<"metric" | "value">({
      name: "kea_exporter_unknown_enum_total",
      help: "Enumeration values reported by Kea that are outside this exporter's recognised set",
      labelNames: ["metric", "value"],
      registers: [registry],
    }),
    parseErrors: new Counter<"group">({
      name: "kea_exporter_parse_errors_total",
      help: "Responses or individual values that could not be parsed, by group",
      labelNames: ["group"],
      registers: [registry],
    }),
  };
}

// Renders one state set (D§3.3): a series per recognised value, exactly one
// at 1. An unrecognised value is counted and leaves every series at 0, so a
// stale 1 can never survive a value Kea has stopped reporting.
export function applyStateSet<T extends string>(
  base: TargetMetricsBase,
  metric: string,
  values: readonly T[],
  classification: StateSetClassification<T>,
  set: (value: T, isActual: 0 | 1) => void,
): void {
  if (classification.kind === "unrecognized") {
    base.unknownEnum.inc({ metric, value: classification.value });
  }
  for (const value of values) {
    set(value, classification.kind === "recognized" && classification.value === value ? 1 : 0);
  }
}
