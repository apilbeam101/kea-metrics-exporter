import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAT_TABLES } from "../../../src/metrics/stat-map.ts";

const tables = Object.values(STAT_TABLES);

describe("statistic tables", () => {
  it("name every counter *_total and no gauge *_total", () => {
    for (const table of tables) {
      for (const family of table.families) {
        assert.equal(family.name.endsWith("_total"), family.type === "counter", family.name);
      }
    }
  });

  it("prefix every family with its daemon", () => {
    for (const table of tables) {
      for (const family of table.families) {
        assert.ok(family.name.startsWith(`kea_${table.daemon}_`), family.name);
      }
    }
  });

  it("point every rule at a family of the same table and scope", () => {
    for (const table of tables) {
      const byName = new Map(table.families.map((f) => [f.name, f]));
      for (const [key, rule] of table.rules) {
        const family = byName.get(rule.family);
        assert.ok(family, `${key} -> ${rule.family}`);
        assert.ok(key.startsWith(`${family.scope}:`), `${key} is filed under ${family.scope}`);
        assert.equal(rule.fixedValue === undefined, family.fixedLabel === undefined, key);
      }
    }
  });

  it("give every family at least one rule", () => {
    for (const table of tables) {
      const used = new Set([...table.rules.values()].map((r) => r.family));
      for (const family of table.families) assert.ok(used.has(family.name), family.name);
    }
  });
});
