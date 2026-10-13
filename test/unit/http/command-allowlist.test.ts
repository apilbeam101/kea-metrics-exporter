import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALLOWED_COMMANDS, assertCommandAllowed } from "../../../src/http/command-allowlist.ts";
import { KEA_FORBIDDEN_READ_COMMANDS, KEA_WRITE_COMMANDS } from "../../support/kea-commands.ts";

describe("command allowlist", () => {
  it("is exactly the six D§3.1 read commands", () => {
    assert.deepEqual([...ALLOWED_COMMANDS].sort(), [
      "config-hash-get",
      "statistic-get-all",
      "status-get",
      "subnet4-list",
      "subnet6-list",
      "version-get",
    ]);
  });

  it("accepts every allowlisted command", () => {
    for (const name of ALLOWED_COMMANDS) assert.doesNotThrow(() => assertCommandAllowed(name));
  });

  it("rejects every write command", () => {
    for (const name of KEA_WRITE_COMMANDS) {
      assert.throws(() => assertCommandAllowed(name), /not in the read-only allowlist/, name);
    }
  });

  it("rejects read commands that expose configuration, secrets or per-client data", () => {
    for (const name of KEA_FORBIDDEN_READ_COMMANDS) {
      assert.throws(() => assertCommandAllowed(name), /not in the read-only allowlist/, name);
    }
  });

  it("does not overlap with the write or forbidden lists", () => {
    const blocked = new Set<string>([...KEA_WRITE_COMMANDS, ...KEA_FORBIDDEN_READ_COMMANDS]);
    for (const name of ALLOWED_COMMANDS) assert.equal(blocked.has(name), false, name);
  });

  it("rejects near-misses and case variants", () => {
    for (const name of ["Status-Get", "status-get ", "status-get\n", "", "statistic-get"]) {
      assert.throws(() => assertCommandAllowed(name), JSON.stringify(name));
    }
  });
});
