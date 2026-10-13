import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatName, templateStatName } from "../../../src/api/stat-name.ts";

describe("parseStatName", () => {
  it("parses global, subnet, pool, prefix-delegation pool and key scopes", () => {
    assert.deepEqual(parseStatName("pkt4-received"), { scope: "global", stem: "pkt4-received" });
    assert.deepEqual(parseStatName("subnet[12].total-addresses"), {
      scope: "subnet",
      subnetId: 12,
      stem: "total-addresses",
    });
    assert.deepEqual(parseStatName("subnet[12].pool[0].assigned-addresses"), {
      scope: "pool",
      subnetId: 12,
      poolId: 0,
      stem: "assigned-addresses",
    });
    assert.deepEqual(parseStatName("subnet[10].pd-pool[3].assigned-pds"), {
      scope: "pd-pool",
      subnetId: 10,
      poolId: 3,
      stem: "assigned-pds",
    });
    assert.deepEqual(parseStatName("key[key1].update-sent"), {
      scope: "key",
      key: "key1",
      stem: "update-sent",
    });
  });

  it("accepts a TSIG key name containing dots", () => {
    assert.deepEqual(parseStatName("key[key1.example.com.].update-error"), {
      scope: "key",
      key: "key1.example.com.",
      stem: "update-error",
    });
  });

  it("rejects indices Kea does not produce, rather than misfiling them as global", () => {
    for (const name of [
      "subnet[x].total-addresses",
      "subnet[-1].total-addresses",
      "subnet[].total-addresses",
      "subnet[1].pool[a].total-addresses",
      "subnet[1].shared[2].total",
      "subnet[1]",
      "pool[0].total-addresses",
      "subnet[99999999999999999999].total-addresses",
      "",
    ]) {
      assert.equal(parseStatName(name), undefined, name);
    }
  });
});

describe("templateStatName", () => {
  it("replaces every index so the label is bounded by the statistic catalogue", () => {
    assert.equal(
      templateStatName("subnet[12].pool[3].future-stat"),
      "subnet[*].pool[*].future-stat",
    );
    assert.equal(templateStatName("key[key1].update-new"), "key[*].update-new");
    assert.equal(templateStatName("pkt4-new-counter"), "pkt4-new-counter");
  });
});
