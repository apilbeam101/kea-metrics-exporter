import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  declaredFamilies,
  generateMetricsDoc,
  METRICS_DOC_PATH,
} from "../../../scripts/generate-metrics-doc.ts";

describe("docs/METRICS.md", () => {
  it("matches a fresh generation", async () => {
    assert.equal(
      readFileSync(METRICS_DOC_PATH, "utf8"),
      await generateMetricsDoc(),
      "docs/METRICS.md is out of date; run npm run generate:metrics-doc",
    );
  });

  it("lists every declared family", async () => {
    const doc = readFileSync(METRICS_DOC_PATH, "utf8");
    const { target, global } = await declaredFamilies();
    for (const family of [...target, ...global]) {
      assert.ok(doc.includes(`\`${family.name}\``), family.name);
    }
  });
});

describe("declared metric families", () => {
  it("type every *_total family as a counter, and no other family", async () => {
    const { target, global } = await declaredFamilies();
    for (const family of [...target, ...global]) {
      assert.equal(family.name.endsWith("_total"), family.type === "counter", family.name);
    }
  });

  it("prefix every family kea_", async () => {
    const { target, global } = await declaredFamilies();
    for (const family of [...target, ...global]) assert.match(family.name, /^kea_/);
  });

  it("give every family help text", async () => {
    const { target, global } = await declaredFamilies();
    for (const family of [...target, ...global]) assert.ok(family.help.length > 10, family.name);
  });
});
