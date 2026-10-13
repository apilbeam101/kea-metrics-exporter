import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import type { Daemon } from "../../../src/config/types.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { createTargetMetricsBase } from "../../../src/metrics/registry.ts";
import { StatusCollector } from "../../../src/metrics/status-collector.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { answer, FakeKeaClient, fixture, type Reply } from "../../support/fake-kea-client.ts";
import { count, series, value } from "../../support/registry.ts";

const NOW_MS = 1_800_000_000_000;

function setup(
  replies: { status: Reply | Reply[]; version?: Reply | Reply[] },
  daemon: Daemon = "dhcp4",
) {
  const registry = new Registry();
  const base = createTargetMetricsBase(registry);
  const client = new FakeKeaClient({
    "status-get": replies.status,
    "version-get": replies.version ?? fixture("version/version-get-extended.json"),
  });
  const warnings: string[] = [];
  const clock = new FakeClock(NOW_MS);
  const collector = new StatusCollector({
    client,
    base,
    daemon,
    clock,
    warn: (m) => warnings.push(m),
  });
  return { registry, client, collector, warnings, clock };
}

describe("StatusCollector: honest up (N6)", () => {
  it("sets kea_up 1 only on a real success", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-mt-on.json") });
    assert.equal((await collector.collect()).kind, "success");
    assert.equal(await value(registry, "kea_up"), 1);
    assert.equal(await value(registry, "kea_collector_success", { collector: "status" }), 1);
  });

  const failures: Array<[string, Reply, string]> = [
    ["an unreachable target", new KeaHttpError("network", "connect refused"), "network"],
    ["a rejected credential", fixture("envelope/auth-forbidden.json", 403), "auth"],
    ["a result-1 status-get", fixture("envelope/error.json"), "api_error"],
    ["a malformed body", fixture("envelope/not-json.txt"), "parse"],
    ["an unparseable status", answer(0, { uptime: "x", reload: 1 }), "parse"],
  ];
  for (const [label, reply, reason] of failures) {
    it(`sets kea_up 0 for ${label}`, async () => {
      const { registry, collector } = setup({ status: reply });
      assert.deepEqual(await collector.collect(), { kind: "failure", reason });
      assert.equal(await value(registry, "kea_up"), 0);
      assert.equal(await value(registry, "kea_collector_success", { collector: "status" }), 0);
    });
  }

  it("drops kea_up to 0 after a success and keeps other series at their last value", async () => {
    const { registry, collector } = setup({
      status: [fixture("status/dhcp4-mt-on.json"), new KeaHttpError("timeout", "slow")],
    });
    await collector.collect();
    await collector.collect();
    assert.equal(await value(registry, "kea_up"), 0);
    assert.equal(await value(registry, "kea_thread_pool_size"), 4);
    assert.equal(await value(registry, "kea_server_version_supported"), 1);
  });

  it("warns once on entering failure, not on every failing cycle", async () => {
    const { collector, warnings } = setup({ status: new KeaHttpError("network", "down") });
    await collector.collect();
    await collector.collect();
    await collector.collect();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /status collector failed \(network\)/);
  });
});

describe("StatusCollector: rendered series", () => {
  it("derives start and reload timestamps from poll time, rounded", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-mt-on.json") });
    await collector.collect();
    assert.equal(await value(registry, "kea_start_time_seconds"), NOW_MS / 1000 - 86523);
    assert.equal(
      await value(registry, "kea_config_reload_timestamp_seconds"),
      NOW_MS / 1000 - 3611,
    );
  });

  it("renders the multi-threading gauges and queue depth windows", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-mt-on.json") });
    await collector.collect();
    assert.equal(await value(registry, "kea_multi_threading_enabled"), 1);
    assert.equal(await value(registry, "kea_thread_pool_size"), 4);
    assert.equal(await value(registry, "kea_packet_queue_size"), 64);
    assert.deepEqual(
      await series(registry, "kea_packet_queue_depth_avg"),
      new Map([
        ["window=10", 0.25],
        ["window=100", 0.11],
        ["window=1000", 0.08],
      ]),
    );
  });

  it("renders no thread-pool or queue series when multi-threading is off", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-mt-off.json") });
    await collector.collect();
    assert.equal(await value(registry, "kea_multi_threading_enabled"), 0);
    assert.equal(await series(registry, "kea_thread_pool_size"), undefined);
    assert.equal(await series(registry, "kea_packet_queue_size"), undefined);
    assert.equal(await count(registry, "kea_packet_queue_depth_avg"), 0);
  });

  it("removes thread-pool series when multi-threading is switched off between cycles", async () => {
    const { registry, collector } = setup({
      status: [fixture("status/dhcp4-mt-on.json"), fixture("status/dhcp4-mt-off.json")],
    });
    await collector.collect();
    await collector.collect();
    assert.equal(await series(registry, "kea_thread_pool_size"), undefined);
    assert.equal(await count(registry, "kea_packet_queue_depth_avg"), 0);
  });

  it("maps each disabled origin to its own series", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-disabled.json") });
    await collector.collect();
    assert.equal(await value(registry, "kea_service_globally_disabled"), 1);
    assert.deepEqual(
      await series(registry, "kea_service_disabled"),
      new Map([
        ["origin=user", 1],
        ["origin=local-command", 1],
        ["origin=remote-command", 1],
        ["origin=db-connection", 1],
      ]),
    );
  });

  it("renders the control socket status as a three-value state set", async () => {
    for (const [file, actual] of [
      ["status/dhcp4-mt-on.json", "ready"],
      ["status/dhcp4-socket-retrying.json", "retrying"],
      ["status/dhcp4-socket-failed.json", "failed"],
    ] as const) {
      const { registry, collector } = setup({ status: fixture(file) });
      await collector.collect();
      const states = await series(registry, "kea_control_socket_status");
      assert.equal(states?.size, 3, file);
      for (const status of ["ready", "retrying", "failed"]) {
        assert.equal(
          states?.get(`status=${status}`),
          status === actual ? 1 : 0,
          `${file} ${status}`,
        );
      }
    }
  });

  it("counts an unrecognised socket status and leaves every state at 0", async () => {
    const { registry, collector } = setup({
      status: answer(0, { uptime: 1, reload: 1, sockets: { status: "reticulating" } }),
    });
    await collector.collect();
    const states = await series(registry, "kea_control_socket_status");
    assert.deepEqual([...(states?.values() ?? [])], [0, 0, 0]);
    assert.equal(
      await value(registry, "kea_exporter_unknown_enum_total", {
        metric: "control_socket_status",
        value: "reticulating",
      }),
      1,
    );
  });

  it("renders only process series for a DDNS target", async () => {
    const { registry, collector } = setup({ status: fixture("status/d2.json") }, "d2");
    await collector.collect();
    assert.equal(await value(registry, "kea_up"), 1);
    assert.ok((await value(registry, "kea_start_time_seconds")) !== undefined);
    for (const name of [
      "kea_multi_threading_enabled",
      "kea_thread_pool_size",
      "kea_service_globally_disabled",
    ]) {
      assert.equal(await series(registry, name), undefined, name);
    }
    for (const name of ["kea_service_disabled", "kea_control_socket_status"]) {
      assert.equal(await count(registry, name), 0, name);
    }
    assert.equal(
      await value(registry, "kea_server_version_info", { version: "3.2.0", daemon: "d2" }),
      1,
    );
  });
});

describe("StatusCollector: version", () => {
  it("labels the version with the configured daemon", async () => {
    const { registry, collector } = setup({ status: fixture("status/dhcp4-mt-on.json") });
    await collector.collect();
    assert.deepEqual(
      await series(registry, "kea_server_version_info"),
      new Map([["daemon=dhcp4,version=3.2.0", 1]]),
    );
    assert.equal(await value(registry, "kea_server_version_supported"), 1);
  });

  it("marks a 2.x daemon unsupported without failing the target", async () => {
    const { registry, collector } = setup({
      status: fixture("status/dhcp4-mt-on.json"),
      version: fixture("version/version-get-2x.json"),
    });
    assert.equal((await collector.collect()).kind, "success");
    assert.equal(await value(registry, "kea_server_version_supported"), 0);
    assert.equal(await value(registry, "kea_up"), 1);
  });

  it("fetches the version once while uptime keeps rising", async () => {
    const status = (uptime: number) => answer(0, { uptime, reload: uptime });
    const { client, collector } = setup({ status: [status(10), status(40), status(70)] });
    await collector.collect();
    await collector.collect();
    await collector.collect();
    assert.equal(client.calls.filter((c) => c === "version-get").length, 1);
  });

  it("fetches the version again after uptime goes backwards, picking up an upgrade", async () => {
    const status = (uptime: number) => answer(0, { uptime, reload: uptime });
    const { registry, client, collector } = setup({
      status: [status(100), status(5)],
      version: [answer(0, undefined, "3.2.0"), answer(0, undefined, "3.2.1")],
    });
    await collector.collect();
    await collector.collect();
    assert.equal(client.calls.filter((c) => c === "version-get").length, 2);
    assert.deepEqual(
      await series(registry, "kea_server_version_info"),
      new Map([["daemon=dhcp4,version=3.2.1", 1]]),
    );
  });

  it("keeps kea_up at 1 when only version-get fails, and retries it next cycle", async () => {
    const { registry, client, collector, warnings } = setup({
      status: fixture("status/dhcp4-mt-on.json"),
      version: [new KeaHttpError("timeout", "slow"), fixture("version/version-get-text-only.json")],
    });
    await collector.collect();
    assert.equal(await value(registry, "kea_up"), 1);
    assert.equal(await value(registry, "kea_collector_success", { collector: "version" }), 0);
    assert.match(warnings[0] ?? "", /version collector failed \(timeout\)/);

    await collector.collect();
    assert.equal(client.calls.filter((c) => c === "version-get").length, 2);
    assert.equal(await value(registry, "kea_collector_success", { collector: "version" }), 1);
  });
});
