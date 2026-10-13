import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { expectOk } from "../../../src/api/envelope.ts";
import { parseStatus } from "../../../src/api/status.ts";
import { HA_STATES } from "../../../src/domain/ha.ts";
import { HaCollector } from "../../../src/metrics/ha-collector.ts";
import { createTargetMetricsBase } from "../../../src/metrics/registry.ts";
import { StatusCollector } from "../../../src/metrics/status-collector.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { FakeKeaClient, fixture } from "../../support/fake-kea-client.ts";
import { assertGolden } from "../../support/golden.ts";
import { count, series, value } from "../../support/registry.ts";

function haOf(path: string): unknown {
  return parseStatus(expectOk("status-get", fixture(path))).highAvailability;
}

function setup() {
  const registry = new Registry();
  const base = createTargetMetricsBase(registry);
  const warnings: string[] = [];
  const collector = new HaCollector({ base, warn: (m) => warnings.push(m) });
  return { registry, collector, warnings };
}

async function haLines(registry: Registry): Promise<string[]> {
  return (await registry.metrics()).split("\n").filter((line) => line.startsWith("kea_ha_"));
}

describe("HaCollector", () => {
  it("gives both sides of a matched pair the same relationship label", async () => {
    const primary = setup();
    const standby = setup();
    primary.collector.apply(haOf("ha/hot-standby-primary.json"));
    standby.collector.apply(haOf("ha/hot-standby-standby.json"));

    for (const { registry } of [primary, standby]) {
      const info = [...((await series(registry, "kea_ha_relationship_info"))?.keys() ?? [])];
      assert.equal(info.length, 1);
      assert.match(info[0] ?? "", /relationship=server1\+server2/);
    }
    assert.equal(
      await value(primary.registry, "kea_ha_relationship_info", {
        relationship: "server1+server2",
        server: "server1",
        partner: "server2",
        mode: "hot-standby",
        role: "primary",
        partner_role: "standby",
      }),
      1,
    );
    assert.equal(
      await value(standby.registry, "kea_ha_scopes_served", {
        relationship: "server1+server2",
        server: "server2",
      }),
      0,
    );
    assert.equal(
      await value(standby.registry, "kea_ha_partner_last_scope", {
        relationship: "server1+server2",
        partner: "server1",
        scope: "server1",
      }),
      1,
    );
  });

  it("renders every one of the thirteen states, locally and for the partner", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/state-sweep.json"));
    const local = await series(registry, "kea_ha_state");
    assert.equal(local?.size, 13 * 13);
    const actual = [...(local?.entries() ?? [])].filter(([, v]) => v === 1).map(([k]) => k);
    assert.equal(actual.length, 13);
    for (const state of HA_STATES) {
      assert.ok(
        actual.some((k) => k.includes(`state=${state}`) && !k.includes(`state=${state}-`)),
        state,
      );
    }
    const partner = await series(registry, "kea_ha_partner_last_state");
    assert.equal([...(partner?.values() ?? [])].filter((v) => v === 1).length, 13);
  });

  it("renders the failover counters of an interrupted relationship", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/load-balancing-interrupted.json"));
    const labels = { relationship: "server1+server2", partner: "server2" };
    const expected: Array<[string, number]> = [
      ["kea_ha_communication_interrupted", 1],
      ["kea_ha_partner_in_touch", 1],
      ["kea_ha_partner_age_seconds", 75],
      ["kea_ha_clock_skew_seconds", -2],
      ["kea_ha_connecting_clients", 5],
      ["kea_ha_unacked_clients", 3],
      ["kea_ha_unacked_clients_left", 7],
      ["kea_ha_analyzed_packets", 42],
    ];
    for (const [name, v] of expected) assert.equal(await value(registry, name, labels), v, name);
  });

  it("renders a partner-down outage truthfully, with clock skew absent rather than frozen", async () => {
    const { registry, collector, warnings } = setup();
    collector.apply(haOf("ha/hot-standby-primary.json"));
    collector.apply(haOf("ha/hot-standby-partner-unreachable.json"));
    const labels = { relationship: "server1+server2", partner: "server2" };
    assert.equal(await value(registry, "kea_collector_success", { collector: "ha" }), 1);
    assert.equal(
      await value(registry, "kea_ha_state", {
        relationship: "server1+server2",
        server: "server1",
        state: "partner-down",
      }),
      1,
    );
    assert.equal(
      await value(registry, "kea_ha_partner_last_state", { ...labels, state: "unavailable" }),
      1,
    );
    assert.equal(await value(registry, "kea_ha_communication_interrupted", labels), 1);
    assert.equal(await value(registry, "kea_ha_partner_age_seconds", labels), 200);
    assert.equal(await value(registry, "kea_ha_clock_skew_seconds", labels), undefined);
    assert.deepEqual(warnings, []);
  });

  it("renders a starting server's own state, and no partner state until it has learned one", async () => {
    const { registry, collector, warnings } = setup();
    collector.apply(haOf("ha/hot-standby-standby-starting.json"));
    assert.equal(await value(registry, "kea_collector_success", { collector: "ha" }), 1);
    assert.equal(
      await value(registry, "kea_ha_state", {
        relationship: "server1+server2",
        server: "server2",
        state: "waiting",
      }),
      1,
    );
    assert.equal(await count(registry, "kea_ha_partner_last_state"), 0);
    assert.equal(await count(registry, "kea_exporter_unknown_enum_total"), 0);
    assert.deepEqual(warnings, []);
  });

  it("renders two relationships for a hub, and drops one removed between cycles", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/hub-two-relationships.json"));
    assert.equal(await value(registry, "kea_ha_relationships"), 2);
    assert.equal(await count(registry, "kea_ha_relationship_info"), 2);

    collector.apply(haOf("ha/hot-standby-primary.json"));
    assert.equal(await value(registry, "kea_ha_relationships"), 1);
    const lines = await haLines(registry);
    assert.equal(lines.filter((l) => l.includes("server3")).length, 0);
  });

  it("renders no partner series without a partner block", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/passive-backup.json"));
    assert.equal(
      await value(registry, "kea_ha_relationship_info", {
        relationship: "server1",
        server: "server1",
        partner: "",
        mode: "passive-backup",
        role: "primary",
        partner_role: "",
      }),
      1,
    );
    for (const name of [
      "kea_ha_partner_last_state",
      "kea_ha_partner_last_scope",
      "kea_ha_communication_interrupted",
      "kea_ha_unacked_clients_left",
    ]) {
      assert.equal(await count(registry, name), 0, name);
    }
  });

  it("counts an unknown state and renders all thirteen series at 0", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/unknown-state.json"));
    const states = await series(registry, "kea_ha_state");
    assert.equal(states?.size, 13);
    assert.ok([...(states?.values() ?? [])].every((v) => v === 0));
    assert.equal(
      await value(registry, "kea_exporter_unknown_enum_total", {
        metric: "ha_state",
        value: "future-state",
      }),
      1,
    );
    assert.equal(
      await value(registry, "kea_exporter_unknown_enum_total", {
        metric: "ha_partner_last_state",
        value: "another-future-state",
      }),
      1,
    );
  });

  it("produces no HA series and no ha collector series when the hook is absent", async () => {
    const { registry, collector } = setup();
    collector.apply(haOf("ha/hot-standby-primary.json"));
    collector.apply(haOf("status/dhcp4-mt-on.json"));
    assert.deepEqual(
      (await haLines(registry)).filter((l) => !l.startsWith("kea_ha_relationships")),
      [],
    );
    assert.equal(await series(registry, "kea_ha_relationships"), undefined);
    assert.equal(await value(registry, "kea_collector_success", { collector: "ha" }), undefined);
  });

  it("keeps the last series and marks the collector failed on a malformed section", async () => {
    const { registry, collector, warnings } = setup();
    collector.apply(haOf("ha/hot-standby-primary.json"));
    collector.apply([{ "ha-mode": "hot-standby" }]);
    collector.apply([{ "ha-mode": "hot-standby" }]);
    assert.equal(await value(registry, "kea_collector_success", { collector: "ha" }), 0);
    assert.equal(await value(registry, "kea_ha_relationships"), 1);
    assert.equal(warnings.length, 1);
  });

  it("maps an unrecognised mode or role to 'unknown' and counts it", async () => {
    const { registry, collector } = setup();
    collector.apply([
      {
        "ha-mode": "mesh",
        "ha-servers": {
          local: { "server-name": "server1", role: "leader", state: "hot-standby", scopes: [] },
        },
      },
    ]);
    assert.equal(
      await value(registry, "kea_ha_relationship_info", {
        relationship: "server1",
        server: "server1",
        partner: "",
        mode: "unknown",
        role: "unknown",
        partner_role: "",
      }),
      1,
    );
    assert.equal(
      await value(registry, "kea_exporter_unknown_enum_total", {
        metric: "ha_mode",
        value: "mesh",
      }),
      1,
    );
  });
});

describe("HA golden expositions", () => {
  const scenarios = [
    ["ha-hot-standby-primary.prom", "ha/hot-standby-primary.json"],
    ["ha-hot-standby-standby.prom", "ha/hot-standby-standby.json"],
    ["ha-load-balancing-interrupted.prom", "ha/load-balancing-interrupted.json"],
  ] as const;

  for (const [golden, status] of scenarios) {
    it(`renders ${status} byte for byte`, async () => {
      const registry = new Registry();
      const base = createTargetMetricsBase(registry);
      const client = new FakeKeaClient({
        "status-get": fixture(status),
        "version-get": fixture("version/version-get-extended.json"),
      });
      const statusCollector = new StatusCollector({
        client,
        base,
        daemon: "dhcp4",
        clock: new FakeClock(1_800_000_000_000),
        warn: () => {},
      });
      const ha = new HaCollector({ base, warn: () => {} });
      const result = await statusCollector.collect();
      assert.equal(result.kind, "success");
      if (result.kind === "success") ha.apply(result.status.highAvailability);
      assertGolden(golden, await registry.metrics());
    });
  }
});
