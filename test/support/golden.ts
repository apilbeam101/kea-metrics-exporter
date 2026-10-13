import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Byte-for-byte comparison against test/fixtures/golden/<name>. Run with
// UPDATE_GOLDEN=1 to rewrite the file instead, then review the diff: a
// changed golden file is a changed public metric surface and needs a
// CHANGELOG entry.
export function assertGolden(name: string, actual: string): void {
  const path = join(process.cwd(), "test", "fixtures", "golden", name);
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `golden file ${name} differs`);
}
