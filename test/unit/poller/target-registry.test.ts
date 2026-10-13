import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { Target, type TargetDeps, TargetRegistry } from "../../../src/poller/target-registry.ts";
import { testConfig } from "../../support/config.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { FakeKeaClient, fixture } from "../../support/fake-kea-client.ts";

function healthy(): FakeKeaClient {
  return new FakeKeaClient({
    "status-get": fixture("ha/hot-standby-primary.json"),
    "version-get": fixture("version/version-get-extended.json"),
    "statistic-get-all": fixture("statistics/dhcp4.json"),
  });
}

function target(client: FakeKeaClient, overrides: Partial<TargetDeps> = {}) {
  const config = testConfig({ "dhcp4-a": { url: "https://kea-a.example.com:8004" } });
  const [targetConfig] = config.targets;
  assert.ok(targetConfig);
  return new Target(targetConfig, config, {
    clock: new FakeClock(1_800_000_000_000),
    warn: () => {},
    createClient: () => client,
    jitter: () => 0,
    ...overrides,
  });
}

describe("Target.runCycle", () => {
  it("collects status, HA and statistics in one cycle", async () => {
    const t = target(healthy());
    assert.deepEqual(await t.runCycle(), { up: true, errors: [] });
    const text = await t.render();
    assert.match(text, /^kea_up 1$/m);
    assert.match(text, /^kea_ha_relationships 1$/m);
    assert.match(text, /^kea_dhcp4_packets_received_all_total 1840212$/m);
  });

  it("skips the statistics call when status-get fails, and marks it failed", async () => {
    const client = healthy();
    client.set("status-get", new KeaHttpError("network", "refused"));
    const t = target(client);
    assert.deepEqual(await t.runCycle(), { up: false, errors: ["network"] });
    assert.equal(client.calls.includes("statistic-get-all"), false);
    const text = await t.render();
    assert.match(text, /^kea_up 0$/m);
    assert.match(text, /^kea_collector_success\{collector="statistics"\} 0$/m);
  });

  it("reports a statistics failure without affecting kea_up", async () => {
    const client = healthy();
    client.set("statistic-get-all", new KeaHttpError("too_large", "big"));
    const t = target(client);
    assert.deepEqual(await t.runCycle(), { up: true, errors: ["too_large"] });
  });

  it("reports a version-get failure as a poll error", async () => {
    const client = healthy();
    client.set("version-get", new KeaHttpError("timeout", "slow"));
    assert.deepEqual(await target(client).runCycle(), { up: true, errors: ["timeout"] });
  });

  it("is ready only after a cycle has completed, success or not", async () => {
    const client = healthy();
    client.set("status-get", new KeaHttpError("auth", "rejected"));
    const t = target(client);
    assert.equal(t.ready, false);
    await t.runCycle();
    assert.equal(t.ready, true);
  });

  it("never lets a render observe half of a cycle", async () => {
    const client = healthy();
    client.set("status-get", [
      fixture("ha/hot-standby-primary.json"),
      fixture("ha/passive-backup.json"),
    ]);
    const t = target(client);
    await t.runCycle();

    // Start a render, then a cycle, and check the render saw the first cycle
    // whole: the hot-standby pair's relationship and none of the second's.
    const rendering = t.render();
    const cycling = t.runCycle();
    const text = await rendering;
    await cycling;
    assert.match(text, /relationship="server1\+server2"/);
    assert.equal(/relationship="server1",/.test(text), false);
    assert.match(await t.render(), /relationship="server1",/);
  });

  it("reports each cycle to onCycle", async () => {
    const seen: string[] = [];
    const t = target(healthy(), { onCycle: (name, r) => seen.push(`${name}:${r.up}`) });
    await t.runCycle();
    assert.deepEqual(seen, ["dhcp4-a:true"]);
  });
});

describe("TargetRegistry", () => {
  it("is ready only once every target has completed a cycle", async () => {
    const config = testConfig({
      "dhcp4-a": { url: "https://kea-a.example.com:8004" },
      "dhcp4-b": { url: "https://kea-b.example.com:8004" },
    });
    const registry = new TargetRegistry(config, {
      clock: new FakeClock(),
      warn: () => {},
      createClient: () => healthy(),
      jitter: () => 0,
    });
    assert.equal(registry.allTargetsReady, false);
    await registry.get("dhcp4-a")?.runCycle();
    assert.equal(registry.allTargetsReady, false);
    await registry.get("dhcp4-b")?.runCycle();
    assert.equal(registry.allTargetsReady, true);
    assert.equal(registry.get("DHCP4-A"), undefined);
  });

  it("polls a DDNS target with its own statistics table", async () => {
    const config = testConfig({ "d2-a": { url: "https://kea-a.example.com:8005", daemon: "d2" } });
    const client = new FakeKeaClient({
      "status-get": fixture("status/d2.json"),
      "version-get": fixture("version/version-get-text-only.json"),
      "statistic-get-all": fixture("statistics/d2.json"),
    });
    const registry = new TargetRegistry(config, {
      clock: new FakeClock(),
      warn: () => {},
      createClient: () => client,
    });
    assert.deepEqual(await registry.get("d2-a")?.runCycle(), { up: true, errors: [] });
    const text = (await registry.get("d2-a")?.render()) ?? "";
    assert.match(text, /^kea_d2_ncr_received_total 5021$/m);
    assert.equal(/^kea_dhcp[46]_/m.test(text), false);
    assert.equal(/^kea_ha_/m.test(text), false);
  });
});
