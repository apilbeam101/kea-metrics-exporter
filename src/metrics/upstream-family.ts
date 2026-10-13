import { Counter, Gauge, type Registry } from "@prometheus-io/client";

export type UpstreamType = "counter" | "gauge";

export interface UpstreamSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

// A metric family whose values are Kea's own, set wholesale each cycle.
//
// Counters are TYPE counter but never incremented locally: Kea's values are
// already lifetime totals, reset by Kea itself on restart and, per subnet,
// on reload (D§3.2.9). The client library's Counter can only inc(), so each
// render resets the family and re-adds the upstream value. A value lower than
// the last render is accepted as-is; detecting that as a reset is
// Prometheus's job.
//
// A label-free family must be genuinely absent when its statistic is
// missing (D§3.2.14), which only removing the metric achieves.
export class UpstreamFamily {
  readonly #registry: Registry;
  readonly #name: string;
  readonly #help: string;
  readonly #type: UpstreamType;
  readonly #labelNames: readonly string[];
  #metric: Counter<string> | Gauge<string> | undefined;

  constructor(
    registry: Registry,
    name: string,
    help: string,
    type: UpstreamType,
    labelNames: readonly string[],
  ) {
    this.#registry = registry;
    this.#name = name;
    this.#help = help;
    this.#type = type;
    this.#labelNames = labelNames;
    // Labelled families are always registered, so HELP and TYPE render even
    // with no series; a label-free one appears only once it has a value.
    if (labelNames.length > 0) this.#ensure();
  }

  get name(): string {
    return this.#name;
  }

  #ensure(): Counter<string> | Gauge<string> {
    if (this.#metric !== undefined) return this.#metric;
    const config = {
      name: this.#name,
      help: this.#help,
      labelNames: [...this.#labelNames],
      registers: [this.#registry],
    };
    this.#metric = this.#type === "counter" ? new Counter(config) : new Gauge(config);
    return this.#metric;
  }

  render(series: readonly UpstreamSeries[]): void {
    if (this.#labelNames.length === 0 && series.length === 0) {
      if (this.#metric !== undefined) {
        this.#registry.removeSingleMetric(this.#name);
        this.#metric = undefined;
      }
      return;
    }

    const metric = this.#ensure();
    metric.reset();
    for (const { labels, value } of series) {
      if (metric instanceof Counter) metric.inc(labels, value);
      else metric.set(labels, value);
    }
  }
}
