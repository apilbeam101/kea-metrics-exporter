import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { createTargetMetricsBase } from "../../../src/metrics/registry.ts";
import { D2_TABLE } from "../../../src/metrics/stat-map.ts";
import { StatisticsCollector } from "../../../src/metrics/statistics-collector.ts";
import { answer, FakeKeaClient, fixture, type Reply } from "../../support/fake-kea-client.ts";
import { assertGolden } from "../../support/golden.ts";
import { count, series, value } from "../../support/registry.ts";

function setup(reply: Reply | Reply[], enableKeyStats = false) {
  const registry = new Registry();
  const collector = new StatisticsCollector({
    client: new FakeKeaClient({ "statistic-get-all": reply }),
    base: createTargetMetricsBase(registry),
    daemon: "d2",
    table: D2_TABLE,
    maxSubnets: 2048,
    enablePoolStats: true,
    enableSubnetLabels: false,
    enableKeyStats,
    warn: () => {},
  });
  return { registry, collector };
}

describe("StatisticsCollector: DHCP-DDNS", () => {
  it("maps the global name-change-request and update counters", async () => {
    const { registry, collector } = setup(fixture("statistics/d2.json"));
    assert.deepEqual(await collector.collect(), { kind: "success" });
    const expected: Array<[string, number]> = [
      ["kea_d2_ncr_received_total", 5021],
      ["kea_d2_ncr_invalid_total", 2],
      ["kea_d2_ncr_errors_total", 1],
      ["kea_d2_queue_full_total", 0],
      ["kea_d2_updates_sent_total", 10040],
      ["kea_d2_updates_signed_total", 10040],
      ["kea_d2_updates_unsigned_total", 0],
      ["kea_d2_updates_succeeded_total", 10022],
      ["kea_d2_updates_timed_out_total", 12],
      ["kea_d2_updates_failed_total", 6],
    ];
    for (const [name, v] of expected) assert.equal(await value(registry, name), v, name);
  });

  it("renders no per-key series, and counts none as unknown, when key stats are off", async () => {
    const { registry, collector } = setup(fixture("statistics/d2.json"));
    await collector.collect();
    assert.equal(await count(registry, "kea_d2_key_updates_sent_total"), 0);
    assert.equal(await count(registry, "kea_exporter_unknown_statistic_total"), 0);
  });

  it("renders one series per TSIG key when key stats are on", async () => {
    const { registry, collector } = setup(fixture("statistics/d2.json"), true);
    await collector.collect();
    assert.deepEqual(
      await series(registry, "kea_d2_key_updates_sent_total"),
      new Map([
        ["key=key1", 6100],
        ["key=key2", 3940],
      ]),
    );
    assert.equal(await value(registry, "kea_d2_key_updates_failed_total", { key: "key2" }), 3);
  });

  it("drops a key removed between cycles", async () => {
    const path = join(process.cwd(), "test", "fixtures", "statistics", "d2.json");
    const full = JSON.parse(readFileSync(path, "utf8"))[0].arguments as Record<string, unknown>;
    const withoutKey2 = Object.fromEntries(
      Object.entries(full).filter(([name]) => !name.startsWith("key[key2]")),
    );
    const { registry, collector } = setup([answer(0, full), answer(0, withoutKey2)], true);
    await collector.collect();
    await collector.collect();
    assert.deepEqual(
      [...((await series(registry, "kea_d2_key_updates_sent_total"))?.keys() ?? [])],
      ["key=key1"],
    );
  });

  it("verifies the daemon from the ncr- prefix", async () => {
    const { registry, collector } = setup(fixture("statistics/d2.json"));
    await collector.collect();
    assert.equal(await value(registry, "kea_daemon_mismatch"), 0);
  });

  it("renders the DDNS statistics fixture byte for byte, key stats on", async () => {
    const { registry, collector } = setup(fixture("statistics/d2.json"), true);
    await collector.collect();
    assertGolden("d2-statistics.prom", await registry.metrics());
  });
});
