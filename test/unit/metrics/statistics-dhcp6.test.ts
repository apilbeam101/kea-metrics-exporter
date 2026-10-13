import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { createTargetMetricsBase } from "../../../src/metrics/registry.ts";
import { DHCP6_TABLE } from "../../../src/metrics/stat-map.ts";
import { StatisticsCollector } from "../../../src/metrics/statistics-collector.ts";
import { answer, FakeKeaClient, fixture, type Reply } from "../../support/fake-kea-client.ts";
import { assertGolden } from "../../support/golden.ts";
import { series, value } from "../../support/registry.ts";

function setup(reply: Reply) {
  const registry = new Registry();
  const collector = new StatisticsCollector({
    client: new FakeKeaClient({ "statistic-get-all": reply }),
    base: createTargetMetricsBase(registry),
    daemon: "dhcp6",
    table: DHCP6_TABLE,
    maxSubnets: 2048,
    enablePoolStats: true,
    enableSubnetLabels: false,
    enableKeyStats: false,
    warn: () => {},
  });
  return { registry, collector };
}

describe("StatisticsCollector: DHCPv6", () => {
  it("maps fixture statistics to their documented families", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp6.json"));
    assert.deepEqual(await collector.collect(), { kind: "success" });
    const expected: Array<[string, Record<string, string>, number]> = [
      ["kea_dhcp6_packets_received_all_total", {}, 922011],
      ["kea_dhcp6_packets_received_total", { type: "renew" }, 480220],
      ["kea_dhcp6_packets_sent_total", { type: "addr-reg-reply" }, 11],
      ["kea_dhcp6_packets_dropped_total", { reason: "duplicate" }, 3100],
      ["kea_dhcp6_nas_assigned", {}, 512],
      ["kea_dhcp6_pds_assigned", {}, 64],
      ["kea_dhcp6_lease_reuses_total", { ia_type: "na" }, 300],
      ["kea_dhcp6_lease_reuses_total", { ia_type: "pd" }, 40],
      ["kea_dhcp6_subnet_pds", { subnet_id: "10" }, 65536],
      ["kea_dhcp6_subnet_registered", { subnet_id: "10" }, 6],
      ["kea_dhcp6_registrations_total", {}, 11],
    ];
    for (const [name, labels, v] of expected) {
      assert.equal(await value(registry, name, labels), v, `${name} ${JSON.stringify(labels)}`);
    }
  });

  it("renders a total-nas of 2^64 as the nearest double", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp6.json"));
    await collector.collect();
    assert.equal(await value(registry, "kea_dhcp6_subnet_nas", { subnet_id: "10" }), 2 ** 64);
    assert.match(
      await registry.metrics(),
      /kea_dhcp6_pool_nas\{subnet_id="10",pool_id="0"\} 18446744073709552000/,
    );
  });

  it("keeps address pools and prefix-delegation pools in separate families", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp6.json"));
    await collector.collect();
    const pool = { subnet_id: "10", pool_id: "0" };
    assert.equal(await value(registry, "kea_dhcp6_pool_nas_assigned", pool), 512);
    assert.equal(await value(registry, "kea_dhcp6_pd_pool_pds_assigned", pool), 64);
    assert.equal(await value(registry, "kea_dhcp6_pool_reclaimed_leases_total", pool), 8600);
    assert.equal(await value(registry, "kea_dhcp6_pd_pool_reclaimed_leases_total", pool), 600);
  });

  it("never files a prefix statistic under an address pool, or the reverse", async () => {
    const { registry, collector } = setup(
      answer(0, {
        "pkt6-received": [[1, "t"]],
        "subnet[10].pool[0].total-pds": [[5, "t"]],
        "subnet[10].pd-pool[0].total-nas": [[5, "t"]],
      }),
    );
    await collector.collect();
    assert.equal(
      await value(registry, "kea_dhcp6_pd_pool_pds", { subnet_id: "10", pool_id: "0" }),
      undefined,
    );
    assert.equal(
      await value(registry, "kea_dhcp6_pool_nas", { subnet_id: "10", pool_id: "0" }),
      undefined,
    );
    assert.deepEqual(
      await series(registry, "kea_exporter_unknown_statistic_total"),
      new Map([
        ["name=subnet[*].pool[*].total-pds", 1],
        ["name=subnet[*].pd-pool[*].total-nas", 1],
      ]),
    );
  });

  it("renders the DHCPv4-over-DHCPv6 message types under type", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp6.json"));
    await collector.collect();
    const received = await series(registry, "kea_dhcp6_packets_received_total");
    assert.ok(received?.has("type=dhcpv4-query"));
    assert.ok(received?.has("type=dhcpv4-response"));
  });

  it("renders the DHCPv6 statistics fixture byte for byte", async () => {
    const { registry, collector } = setup(fixture("statistics/dhcp6.json"));
    await collector.collect();
    assertGolden("dhcp6-statistics.prom", await registry.metrics());
  });
});
