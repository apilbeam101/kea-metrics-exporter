import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { Target } from "../../../src/poller/target-registry.ts";
import { testConfig } from "../../support/config.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { answer, FakeKeaClient, fixture } from "../../support/fake-kea-client.ts";
import { value } from "../../support/registry.ts";

const STATS = answer(0, {
  "pkt4-received": [[1, "t"]],
  "subnet[1].total-addresses": [[200, "t"]],
  "subnet[2].total-addresses": [[250, "t"]],
  "subnet[2].pool[0].total-addresses": [[150, "t"]],
});

function client(): FakeKeaClient {
  return new FakeKeaClient({
    "status-get": fixture("status/dhcp4-mt-on.json"),
    "version-get": fixture("version/version-get-text-only.json"),
    "statistic-get-all": STATS,
    "config-hash-get": fixture("config-hash/hash-a.json"),
    "subnet4-list": fixture("subnets/subnet4-list.json"),
  });
}

function target(kea: FakeKeaClient, enable = true, daemon = "dhcp4") {
  const config = testConfig(
    { t: { url: "https://kea-a.example.com:8004", daemon } },
    { ENABLE_SUBNET_LABELS: String(enable) },
  );
  const [targetConfig] = config.targets;
  assert.ok(targetConfig);
  const warnings: string[] = [];
  const t = new Target(targetConfig, config, {
    clock: new FakeClock(),
    warn: (_name, message) => warnings.push(message),
    createClient: () => kea,
  });
  return { t, warnings };
}

const subnet = (id: string, prefix: string, sharedNetwork: string) => ({
  subnet_id: id,
  prefix,
  shared_network: sharedNetwork,
});

describe("subnet labels", () => {
  it("adds prefix and shared_network to subnet and pool series when enabled", async () => {
    const { t } = target(client());
    await t.runCycle();
    assert.equal(
      await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "192.0.2.0/24", "")),
      200,
    );
    assert.equal(
      await value(
        t.registry,
        "kea_dhcp4_subnet_addresses",
        subnet("2", "198.51.100.0/24", "network1"),
      ),
      250,
    );
    assert.equal(
      await value(t.registry, "kea_dhcp4_pool_addresses", {
        ...subnet("2", "198.51.100.0/24", "network1"),
        pool_id: "0",
      }),
      150,
    );
    assert.equal(await value(t.registry, "kea_command_supported", { command: "subnet4-list" }), 1);
    assert.equal(await value(t.registry, "kea_dhcp4_packets_received_all_total"), 1);
  });

  it("sends neither command and adds no labels when disabled", async () => {
    const kea = client();
    const { t } = target(kea, false);
    await t.runCycle();
    await t.runCycle();
    assert.equal(kea.calls.includes("config-hash-get"), false);
    assert.equal(kea.calls.includes("subnet4-list"), false);
    assert.equal(await value(t.registry, "kea_dhcp4_subnet_addresses", { subnet_id: "1" }), 200);
  });

  it("fetches the list once while the hash is unchanged", async () => {
    const kea = client();
    const { t } = target(kea);
    for (let i = 0; i < 4; i++) await t.runCycle();
    assert.equal(kea.calls.filter((c) => c === "config-hash-get").length, 4);
    assert.equal(kea.calls.filter((c) => c === "subnet4-list").length, 1);
  });

  it("relabels a renumbered subnet on the cycle the hash changes", async () => {
    const kea = client();
    kea.set("config-hash-get", [
      fixture("config-hash/hash-a.json"),
      fixture("config-hash/hash-b.json"),
    ]);
    kea.set("subnet4-list", [
      fixture("subnets/subnet4-list.json"),
      answer(0, { subnets: [{ id: 1, subnet: "203.0.113.0/24" }] }),
    ]);
    const { t } = target(kea);
    await t.runCycle();
    await t.runCycle();
    assert.equal(
      await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "203.0.113.0/24", "")),
      200,
    );
    assert.equal(
      await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "192.0.2.0/24", "")),
      undefined,
    );
    // Subnet 2 is no longer in the list: its series stays, with empty labels.
    assert.equal(await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("2", "", "")), 250);
  });

  it("renders empty labels and stops asking when the hook is absent", async () => {
    const kea = client();
    kea.set("subnet4-list", fixture("subnets/subnet4-list-unsupported.json"));
    const { t, warnings } = target(kea);
    for (let i = 0; i < 3; i++) await t.runCycle();
    assert.equal(kea.calls.filter((c) => c === "subnet4-list").length, 1);
    assert.equal(await value(t.registry, "kea_command_supported", { command: "subnet4-list" }), 0);
    assert.equal(await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "", "")), 200);
    assert.equal(warnings.filter((w) => w.includes("subnet_cmds")).length, 1);
    assert.equal(
      await value(t.registry, "kea_collector_success", { collector: "subnet_labels" }),
      1,
    );
  });

  it("asks again after a configuration change, in case the hook was loaded", async () => {
    const kea = client();
    kea.set("config-hash-get", [
      fixture("config-hash/hash-a.json"),
      fixture("config-hash/hash-b.json"),
    ]);
    kea.set("subnet4-list", [
      fixture("subnets/subnet4-list-unsupported.json"),
      fixture("subnets/subnet4-list.json"),
    ]);
    const { t } = target(kea);
    await t.runCycle();
    await t.runCycle();
    assert.equal(await value(t.registry, "kea_command_supported", { command: "subnet4-list" }), 1);
  });

  it("treats no configured subnets as an empty map, not an error", async () => {
    const kea = client();
    kea.set("subnet4-list", fixture("subnets/subnet4-list-empty.json"));
    const { t } = target(kea);
    assert.deepEqual(await t.runCycle(), { up: true, errors: [] });
    assert.equal(await value(t.registry, "kea_command_supported", { command: "subnet4-list" }), 1);
  });

  it("keeps the previous labels and retries when the list call fails", async () => {
    const kea = client();
    kea.set("config-hash-get", [
      fixture("config-hash/hash-a.json"),
      fixture("config-hash/hash-b.json"),
    ]);
    kea.set("subnet4-list", [
      fixture("subnets/subnet4-list.json"),
      new KeaHttpError("timeout", "slow"),
      answer(0, { subnets: [{ id: 1, subnet: "203.0.113.0/24" }] }),
    ]);
    const { t } = target(kea);
    await t.runCycle();
    assert.deepEqual(await t.runCycle(), { up: true, errors: ["timeout"] });
    assert.equal(
      await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "192.0.2.0/24", "")),
      200,
    );
    assert.equal(
      await value(t.registry, "kea_collector_success", { collector: "subnet_labels" }),
      0,
    );
    await t.runCycle();
    assert.equal(
      await value(t.registry, "kea_dhcp4_subnet_addresses", subnet("1", "203.0.113.0/24", "")),
      200,
    );
  });

  it("makes no subnet calls for a DDNS target even when enabled", async () => {
    const kea = new FakeKeaClient({
      "status-get": fixture("status/d2.json"),
      "version-get": fixture("version/version-get-text-only.json"),
    });
    const { t } = target(kea, true, "d2");
    await t.runCycle();
    assert.equal(kea.calls.includes("config-hash-get"), false);
  });
});
