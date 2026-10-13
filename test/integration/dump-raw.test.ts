import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { dumpRaw } from "../../src/dump-raw.ts";
import { systemClock } from "../../src/http/clock.ts";
import { findLeaks } from "../../src/sanitize.ts";
import { testConfig } from "../support/config.ts";
import { answer, fixture } from "../support/fake-kea-client.ts";
import { MockKeaServer } from "../support/mock-kea-server.ts";

// Deliberately unsanitised: what a real deployment would return.
const REAL_STATUS = answer(0, {
  pid: 1,
  uptime: 100,
  reload: 100,
  "multi-threading-enabled": false,
  sockets: {
    status: "failed",
    errors: ["failed to open socket on interface eth1 address 10.40.12.5 hw 0a:1b:2c:3d:4e:5f"],
  },
  "csv-lease-file": "/var/lib/kea/dhcp4.leases",
  "high-availability": [
    {
      "ha-mode": "hot-standby",
      "ha-servers": {
        local: {
          "server-name": "dhcp-north",
          role: "primary",
          state: "hot-standby",
          scopes: ["dhcp-north"],
        },
        remote: {
          "server-name": "dhcp-south.corp.invalid-company.net",
          role: "standby",
          "last-state": "hot-standby",
          "last-scopes": [],
        },
      },
    },
  ],
});
// Written as text: a JavaScript number literal would round 2^64 before the
// mock ever served it.
const REAL_STATS = {
  statusCode: 200,
  body: '[{"result":0,"arguments":{"pkt4-received":[[5,"2026-01-15 09:30:00.000000"]],"subnet[1].total-addresses":[[18446744073709551616,"2026-01-15 09:30:00.000000"]]}}]',
};
const REAL_SUBNETS = answer(0, {
  subnets: [{ id: 1, subnet: "10.40.12.0/24", "shared-network-name": "floor-3" }],
});

const PASSWORD = "test-password";
const SECRETS = [PASSWORD, "Basic ", Buffer.from(`metrics:${PASSWORD}`).toString("base64")];
const REAL_VALUES = [
  "10.40.12",
  "dhcp-north",
  "dhcp-south",
  "invalid-company",
  "0a:1b:2c:3d:4e:5f",
  "floor-3",
];

describe("--dump-raw", () => {
  let kea: MockKeaServer;

  before(async () => {
    kea = await MockKeaServer.start({
      replies: {
        "status-get": REAL_STATUS,
        "version-get": fixture("version/version-get-extended.json"),
        "statistic-get-all": REAL_STATS,
        "config-hash-get": fixture("config-hash/hash-a.json"),
        "subnet4-list": REAL_SUBNETS,
      },
    });
  });

  after(() => kea.close());

  const config = () => testConfig({ "dhcp4-a": { url: kea.url } });

  it("calls only allowlisted read commands, once each", async () => {
    kea.requests = [];
    await dumpRaw(config(), { clock: systemClock, sanitize: true });
    assert.deepEqual(kea.requests, [
      "version-get",
      "status-get",
      "statistic-get-all",
      "config-hash-get",
      "subnet4-list",
    ]);
  });

  it("contains no credential and no real address or name when sanitised", async () => {
    const text = await dumpRaw(config(), { clock: systemClock, sanitize: true });
    for (const value of [...SECRETS, ...REAL_VALUES, kea.url]) {
      assert.equal(text.includes(value), false, `dump contains ${value}`);
    }
    assert.deepEqual(findLeaks(text), []);
    const parsed = JSON.parse(text);
    assert.equal(parsed.sanitized, true);
    assert.equal(parsed.targets["dhcp4-a"].responses["status-get"].httpStatus, 200);
  });

  it("keeps values above 2^53 exact", async () => {
    const text = await dumpRaw(config(), { clock: systemClock, sanitize: true });
    assert.match(text, /\b18446744073709551616\b/);
  });

  it("contains no credential even unsanitised", async () => {
    const text = await dumpRaw(config(), { clock: systemClock, sanitize: false });
    for (const value of SECRETS) assert.equal(text.includes(value), false, value);
    assert.ok(text.includes("dhcp-north"));
  });

  it("records a failed command instead of aborting the dump", async () => {
    kea.setDown(true);
    const text = await dumpRaw(
      testConfig({ "dhcp4-a": { url: kea.url } }, { REQUEST_TIMEOUT_SECONDS: "1" }),
      {
        clock: systemClock,
        sanitize: true,
      },
    );
    kea.setDown(false);
    const responses = JSON.parse(text).targets["dhcp4-a"].responses;
    assert.match(responses["status-get"].error, /request failed|timed out/);
  });
});
