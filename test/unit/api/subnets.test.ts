import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfigHash } from "../../../src/api/config-hash.ts";
import { classify } from "../../../src/api/envelope.ts";
import { parseSubnetList } from "../../../src/api/subnets.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { fixture } from "../../support/fake-kea-client.ts";

const argsOf = (path: string) => {
  const envelope = classify(fixture(path));
  assert.ok(envelope.kind === "ok" || envelope.kind === "empty");
  return envelope.arguments;
};

const isParse = (error: unknown) => error instanceof KeaHttpError && error.reason === "parse";

describe("parseSubnetList", () => {
  it("maps IDs to prefixes, with an empty shared network when there is none", () => {
    assert.deepEqual(
      parseSubnetList("subnet4-list", argsOf("subnets/subnet4-list.json")),
      new Map([
        [1, { prefix: "192.0.2.0/24", sharedNetwork: "" }],
        [2, { prefix: "198.51.100.0/24", sharedNetwork: "network1" }],
      ]),
    );
    assert.deepEqual(
      parseSubnetList("subnet6-list", argsOf("subnets/subnet6-list.json")),
      new Map([[10, { prefix: "2001:db8:1::/48", sharedNetwork: "network2" }]]),
    );
  });

  it("treats an empty list, or no arguments, as an empty map", () => {
    assert.equal(
      parseSubnetList("subnet4-list", argsOf("subnets/subnet4-list-empty.json")).size,
      0,
    );
    assert.equal(parseSubnetList("subnet4-list", undefined).size, 0);
  });

  it("rejects malformed entries", () => {
    for (const args of [
      "x",
      { subnets: "x" },
      { subnets: [{ id: "1", subnet: "192.0.2.0/24" }] },
      { subnets: [{ id: 1 }] },
      { subnets: [{ id: 1, subnet: "192.0.2.0/24", "shared-network-name": 7 }] },
    ]) {
      assert.throws(() => parseSubnetList("subnet4-list", args), isParse, JSON.stringify(args));
    }
  });
});

describe("parseConfigHash", () => {
  it("reads the hash", () => {
    assert.equal(parseConfigHash(argsOf("config-hash/hash-a.json")), "CONFIG-HASH-PLACEHOLDER-A");
  });

  it("rejects a missing or empty hash", () => {
    for (const args of [undefined, {}, { hash: "" }, { hash: 1 }]) {
      assert.throws(() => parseConfigHash(args), isParse);
    }
  });
});
