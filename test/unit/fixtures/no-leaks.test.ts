import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkPaths } from "../../../scripts/sanitize-fixtures.ts";

describe("committed fixtures", () => {
  it("contain no address, domain, MAC, token, credential or real name", () => {
    const results = checkPaths([join(process.cwd(), "test", "fixtures")]);
    assert.deepEqual(results, []);
  });
});
