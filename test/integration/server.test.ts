import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { systemClock } from "../../src/http/clock.ts";
import { buildGlobalRegistry } from "../../src/index.ts";
import { createLogger } from "../../src/log/logger.ts";
import { TargetRegistry } from "../../src/poller/target-registry.ts";
import { createRequestHandler } from "../../src/server/routes.ts";
import { type StartedServer, startServer } from "../../src/server/server.ts";
import { testConfig } from "../support/config.ts";
import { MockKeaServer } from "../support/mock-kea-server.ts";

const silent = createLogger({ level: "error", format: "json", write: () => {} });

interface Running {
  readonly url: string;
  readonly registry: TargetRegistry;
  readonly started: StartedServer;
}

async function startExporter(targets: Record<string, string>): Promise<Running> {
  const config = testConfig(
    Object.fromEntries(Object.entries(targets).map(([name, url]) => [name, { url }])),
    { METRICS_PORT: "1", METRICS_BIND_ADDRESS: "127.0.0.1" },
  );
  const registry = new TargetRegistry(config, {
    clock: systemClock,
    warn: () => {},
    jitter: () => 0,
  });
  const globalRegistry = buildGlobalRegistry(config, {
    version: "0.0.0-test",
    commit: "test",
    nodeVersion: process.version,
  });
  const handler = createRequestHandler({
    globalRegistry,
    getTargetRegistry: () => registry,
    logger: silent,
  });
  const started = await startServer({ ...config, metricsPort: 0 }, handler, silent);
  const port = (started.server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, registry, started };
}

async function get(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; allow: string | null }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.text(),
    allow: response.headers.get("allow"),
  };
}

describe("exporter over HTTP against mock Kea servers", () => {
  let keaA: MockKeaServer;
  let keaB: MockKeaServer;
  let exporter: Running;

  before(async () => {
    keaA = await MockKeaServer.start();
    keaB = await MockKeaServer.start();
    exporter = await startExporter({ "dhcp4-a": keaA.url, "dhcp4-b": keaB.url });
  });

  after(async () => {
    await exporter.registry.stopAll();
    await exporter.started.close();
    await keaA.close();
    await keaB.close();
  });

  it("answers /healthz at once and /readyz 503 before the first cycle", async () => {
    assert.equal((await get(`${exporter.url}/healthz`)).status, 200);
    assert.equal((await get(`${exporter.url}/readyz`)).status, 503);
  });

  it("serves each target independently after a cycle each", async () => {
    // Cycles are driven by hand so no scheduled cycle can land inside the
    // request-counting assertions below.
    await Promise.all(exporter.registry.targets.map((t) => t.runCycle()));
    assert.equal((await get(`${exporter.url}/readyz`)).status, 200);

    const [a, b] = await Promise.all([
      get(`${exporter.url}/metrics?target=dhcp4-a`),
      get(`${exporter.url}/metrics?target=dhcp4-b`),
    ]);
    for (const response of [a, b]) {
      assert.equal(response.status, 200);
      assert.match(response.body, /^kea_up 1$/m);
      assert.match(response.body, /^kea_dhcp4_packets_received_all_total 1840212$/m);
    }
  });

  it("makes no upstream request when scraped", async () => {
    const before = keaA.requests.length;
    await Promise.all(
      Array.from({ length: 20 }, () => get(`${exporter.url}/metrics?target=dhcp4-a`)),
    );
    assert.equal(keaA.requests.length, before);
  });

  it("keeps one target healthy while the other is hard down", async () => {
    keaB.setDown(true);
    const target = exporter.registry.get("dhcp4-b");
    assert.ok(target);
    await target.runCycle();
    const [a, b] = await Promise.all([
      get(`${exporter.url}/metrics?target=dhcp4-a`),
      get(`${exporter.url}/metrics?target=dhcp4-b`),
    ]);
    assert.match(a.body, /^kea_up 1$/m);
    assert.match(b.body, /^kea_up 0$/m);
    // The down target's last statistics are kept, not dropped (D§5.8).
    assert.match(b.body, /^kea_dhcp4_packets_received_all_total 1840212$/m);
    keaB.setDown(false);
  });

  it("makes no upstream request when scraped during an outage", async () => {
    keaB.setDown(true);
    const before = keaB.requests.length;
    for (let i = 0; i < 20; i++) {
      assert.equal((await get(`${exporter.url}/metrics?target=dhcp4-b`)).status, 200);
    }
    assert.equal(keaB.requests.length, before);
    keaB.setDown(false);
  });

  it("serves only global series on bare /metrics", async () => {
    const { status, body } = await get(`${exporter.url}/metrics`);
    assert.equal(status, 200);
    assert.match(body, /^kea_exporter_build_info\{/m);
    assert.match(body, /^kea_exporter_targets 2$/m);
    assert.equal(/^kea_up /m.test(body), false);
    assert.equal(/^kea_dhcp4_/m.test(body), false);
  });

  it("returns 400 for an unknown target, 404 for an unknown path and 405 with Allow", async () => {
    assert.equal((await get(`${exporter.url}/metrics?target=nope`)).status, 400);
    assert.equal((await get(`${exporter.url}/nope`)).status, 404);
    const post = await get(`${exporter.url}/metrics`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.allow, "GET");
  });

  it("reports a rejected credential as kea_up 0", async () => {
    keaA.set("status-get", {
      statusCode: 403,
      body: JSON.stringify({ result: 403, text: "Forbidden" }),
    });
    await exporter.registry.get("dhcp4-a")?.runCycle();
    assert.match((await get(`${exporter.url}/metrics?target=dhcp4-a`)).body, /^kea_up 0$/m);
  });
});

describe("graceful shutdown", () => {
  it("stops every poller and closes the listener", async () => {
    const kea = await MockKeaServer.start();
    const exporter = await startExporter({ "dhcp4-a": kea.url });
    exporter.registry.startAll();
    await exporter.registry.get("dhcp4-a")?.waitForCycle(1);
    await exporter.registry.stopAll();
    await exporter.started.close();
    await assert.rejects(fetch(`${exporter.url}/healthz`));
    await kea.close();
  });
});
