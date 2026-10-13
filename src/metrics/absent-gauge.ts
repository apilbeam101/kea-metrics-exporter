import { Gauge, type Registry } from "@prometheus-io/client";

// A label-free Gauge renders exactly one series once constructed: reset()
// only zeroes it, it cannot make the series disappear. Metrics that must be
// genuinely absent until they have a real value, and absent again once it
// stops applying (D§3.2.14), remove and recreate the underlying Gauge instead.
export class AbsentUntilSetGauge {
  readonly #registry: Registry;
  readonly #name: string;
  readonly #help: string;
  // For a value computed at render time (cache age) rather than written.
  readonly #computeValue: (() => number) | undefined;
  #gauge: Gauge | undefined;

  constructor(registry: Registry, name: string, help: string, computeValue?: () => number) {
    this.#registry = registry;
    this.#name = name;
    this.#help = help;
    this.#computeValue = computeValue;
  }

  #ensureGauge(): Gauge {
    // collect() runs only at render time, long after this assignment, so the
    // closure can safely read this.#gauge.
    this.#gauge ??= new Gauge({
      name: this.#name,
      help: this.#help,
      registers: [this.#registry],
      ...(this.#computeValue === undefined
        ? {}
        : { collect: () => this.#gauge?.set(this.#computeValue?.() ?? 0) }),
    });
    return this.#gauge;
  }

  set(value: number): void {
    this.#ensureGauge().set(value);
  }

  ensurePresent(): void {
    this.#ensureGauge();
  }

  setOrClear(value: number | undefined): void {
    if (value === undefined) this.clear();
    else this.set(value);
  }

  clear(): void {
    if (this.#gauge === undefined) return;
    this.#registry.removeSingleMetric(this.#name);
    this.#gauge = undefined;
  }
}
