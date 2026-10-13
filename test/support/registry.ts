import type { Registry } from "@prometheus-io/client";

function key(labels: Readonly<Partial<Record<string, string | number>>>): string {
  return Object.entries(labels)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join(",");
}

// Series of one family keyed by their sorted label set ("" for none), or
// undefined when the family is not registered at all. Absent and present-
// with-no-series are kept distinct, since D§3.2.14 makes that difference
// observable.
export async function series(
  registry: Registry,
  name: string,
): Promise<Map<string, number> | undefined> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  if (metric === undefined) return undefined;
  return new Map(metric.values.map((v) => [key(v.labels), v.value]));
}

export async function value(
  registry: Registry,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): Promise<number | undefined> {
  return (await series(registry, name))?.get(key(labels));
}

export async function count(registry: Registry, name: string): Promise<number> {
  return (await series(registry, name))?.size ?? 0;
}
