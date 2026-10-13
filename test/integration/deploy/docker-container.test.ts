import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildTestImage, docker, dockerAvailable, TEST_IMAGE } from "../../support/docker.ts";
import { MockKeaServer } from "../../support/mock-kea-server.ts";

const NAME = `kea-exporter-test-${process.pid}`;

async function waitFor(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      last = (await fetch(url)).status;
      if (last === 200) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

describe("docker container", { skip: !dockerAvailable() && "docker is not available" }, () => {
  let kea: MockKeaServer;
  let port: string;

  before(async () => {
    buildTestImage();
    kea = await MockKeaServer.start({ host: "0.0.0.0" });
    docker([
      "run",
      "-d",
      "--name",
      NAME,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `KEA_TARGETS=dhcp4-a=http://host.docker.internal:${kea.port}`,
      "-e",
      "KEA_DAEMON=dhcp4",
      "-e",
      "KEA_USERNAME=metrics",
      "-e",
      "KEA_PASSWORD=test-password",
      "-p",
      "127.0.0.1::10167",
      TEST_IMAGE,
    ]);
    port = docker(["port", NAME, "10167/tcp"]).trim().split(":").pop() ?? "";
  });

  after(async () => {
    try {
      docker(["rm", "-f", NAME]);
    } catch {}
    await kea.close();
  });

  it("becomes ready against a mock Kea server and serves its series", async () => {
    assert.equal(await waitFor(`http://127.0.0.1:${port}/readyz`, 30_000), 200);
    const body = await (await fetch(`http://127.0.0.1:${port}/metrics?target=dhcp4-a`)).text();
    assert.match(body, /^kea_up 1$/m);
  });

  it("shuts down gracefully on SIGTERM, well inside docker's grace period", () => {
    const started = Date.now();
    docker(["stop", "--time", "10", NAME]);
    assert.ok(Date.now() - started < 8_000, "the container needed SIGKILL");
    const exitCode = docker(["inspect", "--format", "{{.State.ExitCode}}", NAME]).trim();
    assert.equal(exitCode, "0");
    assert.match(docker(["logs", NAME]), /shutdown complete/);
  });
});
