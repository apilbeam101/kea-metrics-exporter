import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectOk } from "../../../src/api/envelope.ts";
import { parseHighAvailability } from "../../../src/api/ha.ts";
import { parseStatus } from "../../../src/api/status.ts";
import { relationshipKey } from "../../../src/domain/ha.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { fixture } from "../../support/fake-kea-client.ts";

const ha = (path: string) =>
  parseHighAvailability(parseStatus(expectOk("status-get", fixture(path))).highAvailability);

const isParse = (error: unknown) => error instanceof KeaHttpError && error.reason === "parse";

describe("relationshipKey", () => {
  it("is the same from both sides of a relationship", () => {
    assert.equal(relationshipKey("server1", "server2"), "server1+server2");
    assert.equal(relationshipKey("server2", "server1"), "server1+server2");
  });

  it("is the local name alone without a partner", () => {
    assert.equal(relationshipKey("server1", undefined), "server1");
  });
});

describe("parseHighAvailability", () => {
  it("returns undefined when the HA hook is not loaded", () => {
    assert.equal(ha("status/dhcp4-mt-on.json"), undefined);
  });

  it("parses both views of a hot-standby pair to the same relationship", () => {
    const [primary] = ha("ha/hot-standby-primary.json") ?? [];
    const [standby] = ha("ha/hot-standby-standby.json") ?? [];
    assert.equal(primary?.relationship, "server1+server2");
    assert.equal(standby?.relationship, "server1+server2");
    assert.deepEqual(primary?.local, {
      serverName: "server1",
      role: "primary",
      state: "hot-standby",
      scopes: ["server1"],
    });
    assert.equal(standby?.remote?.serverName, "server1");
    assert.deepEqual(standby?.remote?.lastScopes, ["server1"]);
  });

  it("parses the partner's failover counters", () => {
    const [rel] = ha("ha/load-balancing-interrupted.json") ?? [];
    assert.deepEqual(rel?.remote, {
      serverName: "server2",
      role: "secondary",
      lastState: "load-balancing",
      lastScopes: ["server2"],
      communicationInterrupted: true,
      inTouch: true,
      ageSeconds: 75,
      clockSkewSeconds: -2,
      connectingClients: 5,
      unackedClients: 3,
      unackedClientsLeft: 7,
      analyzedPackets: 42,
    });
  });

  it("parses one relationship per hub entry", () => {
    const relationships = ha("ha/hub-two-relationships.json") ?? [];
    assert.deepEqual(
      relationships.map((r) => r.relationship),
      ["server1+server2", "server1+server3"],
    );
  });

  it("accepts a relationship with no partner block", () => {
    const [rel] = ha("ha/passive-backup.json") ?? [];
    assert.equal(rel?.remote, undefined);
    assert.equal(rel?.relationship, "server1");
  });

  it("passes unrecognised states through for the metrics layer to count", () => {
    const [rel] = ha("ha/unknown-state.json") ?? [];
    assert.equal(rel?.local.state, "future-state");
    assert.equal(rel?.remote?.lastState, "another-future-state");
  });

  it("leaves absent partner fields undefined rather than zero", () => {
    const [rel] =
      parseHighAvailability([
        {
          "ha-mode": "hot-standby",
          "ha-servers": {
            local: { "server-name": "server1", role: "primary", state: "hot-standby", scopes: [] },
            remote: {
              "server-name": "server2",
              role: "standby",
              "last-state": "hot-standby",
              "last-scopes": [],
            },
          },
        },
      ]) ?? [];
    assert.equal(rel?.remote?.unackedClientsLeft, undefined);
    assert.equal(rel?.remote?.communicationInterrupted, undefined);
  });

  it("rejects malformed sections", () => {
    const local = { "server-name": "server1", role: "primary", state: "hot-standby", scopes: [] };
    for (const value of [
      {},
      [1],
      [{ "ha-servers": { local } }],
      [{ "ha-mode": "hot-standby" }],
      [{ "ha-mode": "hot-standby", "ha-servers": { local: { ...local, scopes: "server1" } } }],
      [{ "ha-mode": "hot-standby", "ha-servers": { local: { ...local, "server-name": "" } } }],
      [{ "ha-mode": "hot-standby", "ha-servers": { local, remote: { "server-name": "server2" } } }],
      [
        {
          "ha-mode": "hot-standby",
          "ha-servers": {
            local,
            remote: {
              "server-name": "server2",
              role: "standby",
              "last-state": "hot-standby",
              "last-scopes": [],
              age: "5",
            },
          },
        },
      ],
    ]) {
      assert.throws(() => parseHighAvailability(value), isParse, JSON.stringify(value));
    }
  });
});
