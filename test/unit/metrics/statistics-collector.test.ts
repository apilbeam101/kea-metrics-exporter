import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import type { Daemon } from "../../../src/config/types.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { createTargetMetricsBase } from "../../../src/metrics/registry.ts";
import { DHCP4_TABLE, type StatTable } from "../../../src/metrics/stat-map.ts";
import { observedDaemons, StatisticsCollector } from "../../../src/metrics/statistics-collector.ts";
import { answer, FakeKeaClient, fixture, type Reply } from "../../support/fake-kea-client.ts";
import { assertGolden } from "../../support/golden.ts";
import { count, series, value } from "../../support/registry.ts";

type Stats = Record<string, Array<[number, string]>>;

function dhcp4Stats(): Stats {
  const path = join(process.cwd(), "test", "fixtures", "statistics", "dhcp4.json");
  return JSON.parse(readFileSync(path, "utf8"))[0].arguments;
}

function setup(
  reply: Reply | Reply[],
  options: {
    daemon?: Daemon;
    table?: StatTable;
    maxSubnets?: number;
    enablePoolStats?: boolean;
    enableSubnetLabels?: boolean;
  } = {},
) {
  const registry = new Registry();
  const base = createTargetMetricsBase(registry);
  const warnings: string[] = [];
  const collector = new StatisticsCollector({
    client: new FakeKeaClient({ "statistic-get-all": reply }),
    base,
    daemon: options.daemon ?? "dhcp4",
    table: options.table ?? DHCP4_TABLE,
    maxSubnets: options.maxSubnets ?? 2048,
    enablePoolStats: options.enablePoolStats ?? true,
    enableSubnetLabels: options.enableSubnetLabels ?? false,
    enableKeyStats: false,
    warn: (m) => warnings.push(m),
  });
  return { registry, collector, warnings };
}

async function types(registry: Registry): Promise<Map<string, string>> {
  return new Map((await registry.getMetricsAsJSON()).map((m) => [m.name, String(m.type)]));
}

describe("StatisticsCollector: DHCPv4 mapping", () => {
  it("maps fixture statistics to their documented families and types", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    assert.deepEqual(await collector.collect(), { kind: "success" });
    const t = await types(registry);

    const expected: Array<[string, Record<string, string>, number, string]> = [
      ["kea_dhcp4_packets_received_all_total", {}, 1840212, "counter"],
      ["kea_dhcp4_packets_received_total", { type: "discover" }, 402113, "counter"],
      ["kea_dhcp4_packets_sent_total", { type: "lease-query-response-active" }, 9, "counter"],
      ["kea_dhcp4_packets_dropped_all_total", {}, 42669, "counter"],
      ["kea_dhcp4_packets_dropped_total", { reason: "queue-full" }, 118, "counter"],
      ["kea_dhcp4_packets_dropped_total", { reason: "parse-failed" }, 12, "counter"],
      ["kea_dhcp4_addresses_assigned", {}, 361, "gauge"],
      ["kea_dhcp4_assignments_total", {}, 18823, "counter"],
      ["kea_dhcp4_allocation_failures_total", {}, 14, "counter"],
      ["kea_dhcp4_allocation_failures_by_cause_total", { cause: "classes" }, 3, "counter"],
      ["kea_dhcp4_subnet_addresses", { subnet_id: "2" }, 250, "gauge"],
      ["kea_dhcp4_subnet_addresses_assigned", { subnet_id: "1" }, 181, "gauge"],
      ["kea_dhcp4_subnet_assignments_total", { subnet_id: "1" }, 9050, "counter"],
      ["kea_dhcp4_pool_addresses", { subnet_id: "2", pool_id: "1" }, 100, "gauge"],
      ["kea_dhcp4_pool_addresses_assigned", { subnet_id: "2", pool_id: "0" }, 120, "gauge"],
      ["kea_dhcp4_pool_reclaimed_leases_total", { subnet_id: "1", pool_id: "0" }, 8869, "counter"],
    ];
    for (const [name, labels, v, type] of expected) {
      assert.equal(await value(registry, name, labels), v, `${name} ${JSON.stringify(labels)}`);
      assert.equal(t.get(name), type, name);
    }
  });

  it("keeps aggregate and per-type packet counters in separate families", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    const perType = await series(registry, "kea_dhcp4_packets_received_total");
    assert.equal(
      [...(perType?.keys() ?? [])].some((k) => k === ""),
      false,
    );
    assert.equal(await count(registry, "kea_dhcp4_packets_received_all_total"), 1);
  });

  it("renders a missing statistic as no series, not as zero", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    assert.equal(
      await value(registry, "kea_dhcp4_packets_received_total", { type: "inform" }),
      undefined,
    );
  });

  it("renders a 20-sample history identically to a single-sample one", async () => {
    const full = dhcp4Stats();
    const single = Object.fromEntries(
      Object.entries(full).map(([k, samples]) => [k, samples.slice(0, 1)]),
    );
    const a = setup(answer(0, full));
    const b = setup(answer(0, single));
    await a.collector.collect();
    await b.collector.collect();
    assert.equal(await a.registry.metrics(), await b.registry.metrics());
  });

  it("counts an empty sample list as a parse error and renders nothing for it", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    assert.equal(
      await value(registry, "kea_dhcp4_packets_received_total", { type: "lease-query" }),
      undefined,
    );
    assert.equal(
      await value(registry, "kea_exporter_parse_errors_total", { group: "statistics" }),
      1,
    );
  });

  it("counts unknown statistics under templated names", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    assert.deepEqual(
      await series(registry, "kea_exporter_unknown_statistic_total"),
      new Map([
        ["name=pkt4-hypothetical-new-counter", 1],
        ["name=subnet[*].pool[*].future-stat", 1],
      ]),
    );
  });
});

describe("StatisticsCollector: series lifecycle", () => {
  it("drops a subnet, and its pools, removed between renders", async () => {
    const full = dhcp4Stats();
    const without2 = Object.fromEntries(
      Object.entries(full).filter(([k]) => !k.startsWith("subnet[2]")),
    );
    const { registry, collector } = setup([answer(0, full), answer(0, without2)]);
    await collector.collect();
    await collector.collect();
    const text = await registry.metrics();
    assert.equal(text.includes('subnet_id="2"'), false);
    assert.ok(text.includes('subnet_id="1"'));
  });

  it("drops a global statistic that disappears, including a label-free one", async () => {
    const full = dhcp4Stats();
    const { "pkt4-received": _, ...rest } = full;
    const { registry, collector } = setup([answer(0, full), answer(0, rest)]);
    await collector.collect();
    await collector.collect();
    assert.equal(await series(registry, "kea_dhcp4_packets_received_all_total"), undefined);
  });

  it("accepts a counter value lower than the previous render, as Kea resets it on reload", async () => {
    const stats = (n: number) => ({ "subnet[1].cumulative-assigned-addresses": [[n, "t"]] });
    const { registry, collector } = setup([answer(0, stats(500)), answer(0, stats(3))]);
    await collector.collect();
    await collector.collect();
    assert.equal(
      await value(registry, "kea_dhcp4_subnet_assignments_total", { subnet_id: "1" }),
      3,
    );
  });

  it("keeps every series at its last value when statistic-get-all fails", async () => {
    const { registry, collector, warnings } = setup([
      fixture("statistics/dhcp4.json"),
      new KeaHttpError("timeout", "slow"),
    ]);
    await collector.collect();
    assert.deepEqual(await collector.collect(), { kind: "failure", reason: "timeout" });
    assert.equal(await value(registry, "kea_dhcp4_packets_received_all_total"), 1840212);
    assert.equal(await value(registry, "kea_collector_success", { collector: "statistics" }), 0);
    assert.match(warnings[0] ?? "", /statistics collector failed \(timeout\)/);
  });

  it("skips every pool series when pool statistics are disabled", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"), {
      enablePoolStats: false,
    });
    await collector.collect();
    assert.equal(await count(registry, "kea_dhcp4_pool_addresses"), 0);
    assert.equal(await count(registry, "kea_dhcp4_subnet_addresses"), 2);
    const unknown = await series(registry, "kea_exporter_unknown_statistic_total");
    assert.equal(unknown?.has("name=subnet[*].pool[*].future-stat"), false);
  });

  it("truncates to the lowest subnet IDs and reports how many were dropped", async () => {
    const stats: Stats = {};
    for (const id of [9, 3, 7, 1, 5]) stats[`subnet[${id}].total-addresses`] = [[10, "t"]];
    const { registry, collector } = setup(answer(0, stats), { maxSubnets: 2 });
    await collector.collect();
    assert.deepEqual(
      [...((await series(registry, "kea_dhcp4_subnet_addresses"))?.keys() ?? [])].sort(),
      ["subnet_id=1", "subnet_id=3"],
    );
    assert.equal(await value(registry, "kea_exporter_subnets_truncated"), 3);
  });
});

describe("StatisticsCollector: daemon verification", () => {
  it("detects which daemons a set of statistic names belongs to", () => {
    assert.deepEqual(observedDaemons(["pkt4-received", "subnet[1].total-addresses"]), ["dhcp4"]);
    assert.deepEqual(observedDaemons(["pkt6-received"]), ["dhcp6"]);
    assert.deepEqual(observedDaemons(["ncr-received"]), ["d2"]);
    assert.deepEqual(observedDaemons(["subnet[1].total-addresses"]), []);
  });

  it("reports a match as 0", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    assert.equal(await value(registry, "kea_daemon_mismatch"), 0);
  });

  it("flags DHCPv6 statistics on a dhcp4 target and renders no DHCPv4 series", async () => {
    const { registry, collector, warnings } = setup([
      fixture("statistics/dhcp4.json"),
      fixture("statistics/dhcp6.json"),
    ]);
    await collector.collect();
    assert.deepEqual(await collector.collect(), { kind: "mismatch", observed: ["dhcp6"] });
    assert.equal(await value(registry, "kea_daemon_mismatch"), 1);
    assert.equal(await value(registry, "kea_collector_success", { collector: "statistics" }), 0);
    const lines = (await registry.metrics()).split("\n").filter((l) => /^kea_dhcp4_/.test(l));
    assert.deepEqual(lines, []);
    assert.match(warnings[0] ?? "", /configured as dhcp4 but returns dhcp6/);
  });

  it("treats a response with no daemon-specific names as inconclusive", async () => {
    const { registry, collector } = setup(answer(0, { "subnet[1].total-addresses": [[10, "t"]] }));
    assert.deepEqual(await collector.collect(), { kind: "success" });
    assert.equal(await series(registry, "kea_daemon_mismatch"), undefined);
  });
});

describe("DHCPv4 golden exposition", () => {
  it("renders the DHCPv4 statistics fixture byte for byte", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp4.json"));
    await collector.collect();
    assertGolden("dhcp4-statistics.prom", await registry.metrics());
  });
});
