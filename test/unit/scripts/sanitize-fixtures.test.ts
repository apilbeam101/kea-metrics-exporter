import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkPaths, listFiles, parseSanitizeArgs } from "../../../scripts/sanitize-fixtures.ts";

describe("checkPaths", () => {
  let root: string;

  before(() => {
    const base = join(process.cwd(), ".test-tmp");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "sanitize-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a clean fixture tree", () => {
    const dir = join(root, "clean");
    mkdirSync(dir);
    writeFileSync(join(dir, "ok.json"), '[{"result": 0, "text": "192.0.2.1"}]');
    assert.deepEqual(checkPaths([dir]), []);
  });

  // The Phase 1 exit criterion: the guard must fail on a planted bad fixture
  // of every kind it claims to detect.
  const planted: Array<[string, string, string]> = [
    ["ip", "private-ip.json", '[{"text": "10.0.0.1"}]'],
    ["ip", "ula.json", '[{"text": "fd00:1::1"}]'],
    ["domain", "domain.json", '[{"text": "kea.corp.invalid-company.net"}]'],
    ["mac", "mac.json", '[{"hw-address": "0a:1b:2c:3d:4e:5f"}]'],
    ["token", "token.json", `[{"hash": "${"f0".repeat(32)}"}]`],
    ["credential", "credential.json", '[{"password": "hunter2"}]'],
    ["name", "server-name.json", '[{"server-name": "dhcp-north"}]'],
    ["name", "key-name.json", '{"key[ddns-key.zone].update-sent": []}'],
  ];

  for (const [kind, file, content] of planted) {
    it(`fails on a planted ${kind} leak (${file})`, () => {
      const dir = join(root, `bad-${file}`);
      mkdirSync(dir);
      writeFileSync(join(dir, file), content);
      const results = checkPaths([dir]);
      assert.equal(results.length, 1);
      assert.ok(results[0]?.leaks.some((leak) => leak.kind === kind));
    });
  }

  it("skips Markdown files alongside fixtures", () => {
    const dir = join(root, "with-readme");
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), "The `dhcp-state.disabled-by-user` field.");
    assert.deepEqual(checkPaths([dir]), []);
  });

  it("throws on a missing check target rather than vacuously passing", () => {
    assert.throws(() => listFiles(join(root, "does-not-exist")));
  });
});

describe("parseSanitizeArgs", () => {
  it("treats every argument as an input when --out-dir is absent", () => {
    assert.deepEqual(parseSanitizeArgs(["a.json"]), { inputs: ["a.json"], outDir: undefined });
  });

  it("separates --out-dir from the inputs wherever it appears", () => {
    assert.deepEqual(parseSanitizeArgs(["a.json", "--out-dir", "out", "b.json"]), {
      inputs: ["a.json", "b.json"],
      outDir: "out",
    });
  });
});
