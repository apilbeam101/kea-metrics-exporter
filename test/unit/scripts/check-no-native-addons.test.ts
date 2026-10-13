import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findNativeAddons } from "../../../scripts/check-no-native-addons.ts";

describe("findNativeAddons", () => {
  let root: string;

  // Scratch space stays inside the gitignored project-local .test-tmp/ rather
  // than the OS temp directory, so test runs never write outside the repo.
  before(() => {
    const base = join(process.cwd(), ".test-tmp");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "native-addons-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing for a tree with no .node files", () => {
    mkdirSync(join(root, "some-package", "lib"), { recursive: true });
    writeFileSync(join(root, "some-package", "lib", "index.js"), "module.exports = {};");

    assert.deepEqual(findNativeAddons(root), []);
  });

  it("finds a .node binary nested inside a package", () => {
    const pkgDir = join(root, "native-package", "build", "Release");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "addon.node"), "");

    const result = findNativeAddons(root);

    assert.ok(
      result.some((p) => p.endsWith(join("native-package", "build", "Release", "addon.node"))),
    );
  });

  it("returns paths relative to the scanned root", () => {
    const result = findNativeAddons(root);
    for (const path of result) {
      assert.equal(path.startsWith(root), false);
    }
  });

  it("does not throw when the root directory does not exist", () => {
    assert.deepEqual(findNativeAddons(join(root, "does-not-exist")), []);
  });
});
