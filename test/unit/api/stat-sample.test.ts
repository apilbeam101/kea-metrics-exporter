import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { currentValue } from "../../../src/api/stat-sample.ts";

const stats = (file: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "statistics", file), "utf8"))[0]
    .arguments as Record<string, unknown>;

describe("currentValue", () => {
  it("reads the newest sample from a 20-sample history", () => {
    const samples = stats("dhcp4.json")["pkt4-received"] as Array<[number, string]>;
    assert.equal(samples.length, 20);
    assert.deepEqual(currentValue(samples), { ok: true, value: samples[0]?.[0] });
  });

  it("reads a single-sample history", () => {
    assert.deepEqual(currentValue([[7, "2026-01-15 09:30:00.000000"]]), { ok: true, value: 7 });
  });

  it("reads a value above 2^53 as the nearest double, without failing", () => {
    const value = currentValue(stats("dhcp6.json")["subnet[10].total-nas"]);
    assert.deepEqual(value, { ok: true, value: 2 ** 64 });
  });

  it("ignores the timestamp entirely", () => {
    assert.deepEqual(currentValue([[3, "not a timestamp"]]), { ok: true, value: 3 });
    assert.deepEqual(currentValue([[3]]), { ok: true, value: 3 });
  });

  it("rejects an empty history and non-numeric or non-finite values", () => {
    for (const samples of [[], undefined, "x", [[]], [["7", "t"]], [[null, "t"]], [7], {}]) {
      assert.deepEqual(currentValue(samples), { ok: false }, JSON.stringify(samples));
    }
  });
});
