import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawResponse } from "../../../src/http/client.ts";
import type { AllowedCommand } from "../../../src/http/command-allowlist.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { Target } from "../../../src/poller/target-registry.ts";
import { testConfig } from "../../support/config.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { FakeKeaClient, fixture } from "../../support/fake-kea-client.ts";
import { series, value } from "../../support/registry.ts";

const NOW = 1_800_000_000_000;

// Reports each call to the target's attempt hook, the way the real client
// does, so upstream telemetry can be checked without a socket.
function reportingClient(kea: FakeKeaClient, clock: FakeClock) {
  return (_target: unknown, onAttempt: (o: never) => void) => ({
    command: async (name: AllowedCommand): Promise<RawResponse> => {
      try {
        const response = await kea.command(name);
        clock.advance(20);
        onAttempt({
          command: name,
          durationMs: 20,
          statusCode: response.statusCode,
          bytes: response.body.length,
        } as never);
        return response;
      } catch (error) {
        onAttempt({
          command: name,
          durationMs: 5,
          reason: (error as KeaHttpError).reason,
        } as never);
        throw error;
      }
    },
  });
}

function setup(kea: FakeKeaClient, extra: Record<string, string> = {}) {
  const clock = new FakeClock(NOW);
  const config = testConfig({ t: { url: "https://kea-a.example.com:8004" } }, extra);
  const [targetConfig] = config.targets;
  assert.ok(targetConfig);
  const target = new Target(targetConfig, config, {
    clock,
    warn: () => {},
    createClient: reportingClient(kea, clock),
  });
  return { target, clock };
}

function healthy(): FakeKeaClient {
  return new FakeKeaClient({
    "status-get": fixture("status/dhcp4-mt-on.json"),
    "version-get": fixture("version/version-get-text-only.json"),
    "statistic-get-all": fixture("statistics/dhcp4.json"),
  });
}

describe("self-metrics", () => {
  it("counts cycles and failed commands by reason", async () => {
    const kea = healthy();
    kea.set("status-get", [
      fixture("status/dhcp4-mt-on.json"),
      new KeaHttpError("network", "down"),
    ]);
    const { target } = setup(kea);
    await target.runCycle();
    await target.runCycle();
    assert.equal(await value(target.registry, "kea_exporter_poll_total"), 2);
    assert.equal(
      await value(target.registry, "kea_exporter_poll_errors_total", { reason: "network" }),
      1,
    );
  });

  it("keeps the last success time and a cache age that grows while the target is down", async () => {
    const kea = healthy();
    kea.set("status-get", [
      fixture("status/dhcp4-mt-on.json"),
      new KeaHttpError("network", "down"),
    ]);
    const { target, clock } = setup(kea);
    assert.equal(await series(target.registry, "kea_exporter_cache_age_seconds"), undefined);
    assert.equal(
      await series(target.registry, "kea_exporter_last_successful_poll_timestamp_seconds"),
      undefined,
    );

    await target.runCycle();
    const succeededAt = await value(
      target.registry,
      "kea_exporter_last_successful_poll_timestamp_seconds",
    );
    assert.ok(succeededAt !== undefined && Math.abs(succeededAt - NOW / 1000) < 1);

    clock.advance(90_000);
    await target.runCycle();
    assert.equal(
      await value(target.registry, "kea_exporter_last_successful_poll_timestamp_seconds"),
      succeededAt,
    );
    const age = await value(target.registry, "kea_exporter_cache_age_seconds");
    assert.ok(age !== undefined && age >= 90, `cache age ${age}`);
  });

  it("counts upstream attempts by command and status, and records response sizes", async () => {
    const kea = healthy();
    kea.set("statistic-get-all", new KeaHttpError("timeout", "slow"));
    const { target } = setup(kea);
    await target.runCycle();
    assert.equal(
      await value(target.registry, "kea_exporter_upstream_requests_total", {
        command: "status-get",
        status_code: "200",
      }),
      1,
    );
    assert.equal(
      await value(target.registry, "kea_exporter_upstream_requests_total", {
        command: "statistic-get-all",
        status_code: "timeout",
      }),
      1,
    );
    assert.equal(
      await value(target.registry, "kea_exporter_upstream_response_bytes", {
        command: "status-get",
      }),
      fixture("status/dhcp4-mt-on.json").body.length,
    );
  });

  it("counts the series the target renders", async () => {
    const { target } = setup(healthy());
    await target.runCycle();
    const text = await target.render();
    const rendered = text.split("\n").filter((l) => l !== "" && !l.startsWith("#")).length;
    assert.equal(await value(target.registry, "kea_exporter_series"), rendered);
  });

  it("reports disabled TLS verification", async () => {
    const off = setup(healthy());
    const on = setup(healthy(), { KEA_TLS_INSECURE_SKIP_VERIFY: "true" });
    assert.equal(await value(off.target.registry, "kea_exporter_tls_verification_disabled"), 0);
    assert.equal(await value(on.target.registry, "kea_exporter_tls_verification_disabled"), 1);
  });
});
