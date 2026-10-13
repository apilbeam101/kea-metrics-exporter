import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectOk } from "../../../src/api/envelope.ts";
import { parseStatus } from "../../../src/api/status.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { fixture } from "../../support/fake-kea-client.ts";

const parse = (path: string) => parseStatus(expectOk("status-get", fixture(path)));

const isParse = (error: unknown) => error instanceof KeaHttpError && error.reason === "parse";

describe("parseStatus", () => {
  it("parses a multi-threaded DHCPv4 daemon", () => {
    const status = parse("status/dhcp4-mt-on.json");
    assert.equal(status.uptimeSeconds, 86523);
    assert.equal(status.reloadSeconds, 3611);
    assert.deepEqual(status.multiThreading, {
      enabled: true,
      threadPoolSize: 4,
      packetQueueSize: 64,
      queueDepthAverages: [0.25, 0.11, 0.08],
    });
    assert.equal(status.socketStatus, "ready");
    assert.deepEqual(status.dhcpState, {
      globallyDisabled: false,
      disabledBy: {
        user: false,
        "local-command": false,
        "remote-command": false,
        "db-connection": false,
      },
    });
    assert.equal(status.highAvailability, undefined);
  });

  it("parses multi-threading off with no pool or queue fields", () => {
    assert.deepEqual(parse("status/dhcp4-mt-off.json").multiThreading, {
      enabled: false,
      threadPoolSize: undefined,
      packetQueueSize: undefined,
      queueDepthAverages: [],
    });
  });

  it("treats each non-empty disabled-by list as held, whatever its element type", () => {
    assert.deepEqual(parse("status/dhcp4-disabled.json").dhcpState, {
      globallyDisabled: true,
      disabledBy: {
        user: true,
        "local-command": true,
        "remote-command": true,
        "db-connection": true,
      },
    });
  });

  it("reads each socket status", () => {
    assert.equal(parse("status/dhcp4-socket-retrying.json").socketStatus, "retrying");
    assert.equal(parse("status/dhcp4-socket-failed.json").socketStatus, "failed");
  });

  it("leaves DHCP-only fields undefined for the DDNS daemon", () => {
    const status = parse("status/d2.json");
    assert.equal(status.multiThreading, undefined);
    assert.equal(status.socketStatus, undefined);
    assert.equal(status.dhcpState, undefined);
    assert.equal(status.highAvailability, undefined);
  });

  it("passes the HA section through unparsed", () => {
    assert.ok(Array.isArray(parse("ha/hot-standby-primary.json").highAvailability));
  });

  it("rejects missing required fields and wrongly typed optional ones", () => {
    for (const args of [
      {},
      { uptime: 1 },
      { uptime: "1", reload: 1 },
      { uptime: 1, reload: 1, "multi-threading-enabled": "yes" },
      { uptime: 1, reload: 1, "multi-threading-enabled": true, "thread-pool-size": "4" },
      { uptime: 1, reload: 1, "multi-threading-enabled": true, "packet-queue-statistics": ["x"] },
      { uptime: 1, reload: 1, sockets: {} },
      { uptime: 1, reload: 1, "dhcp-state": [] },
      { uptime: 1, reload: 1, "dhcp-state": { "disabled-by-user": "no" } },
      { uptime: 1, reload: 1, "dhcp-state": { "disabled-by-local-command": "x" } },
    ]) {
      assert.throws(() => parseStatus(args), isParse, JSON.stringify(args));
    }
    assert.throws(() => parseStatus(undefined), isParse);
  });
});
