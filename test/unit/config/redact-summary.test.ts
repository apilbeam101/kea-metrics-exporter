import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSummary } from "../../../src/config/redact-summary.ts";
import { validate } from "../../../src/config/validate.ts";

describe("redactSummary", () => {
  const { config } = validate(
    {
      KEA_TARGETS: "dhcp4-a=https://kea-a.example.com:8004",
      KEA_DAEMON: "dhcp4",
      KEA_USERNAME: "metrics",
      KEA_PASSWORD_FILE: "/run/secrets/kea",
    },
    { readFile: () => "summary-password\n" },
  );

  it("names where the password came from without containing it", () => {
    const [target] = redactSummary(config).targets as Array<Record<string, unknown>>;
    assert.equal(target?.password, "[REDACTED]");
    assert.deepEqual(target?.passwordSource, {
      kind: "file",
      variable: "KEA_PASSWORD_FILE",
      path: "/run/secrets/kea",
    });
  });

  it("returns plain data with no live Secret reachable", () => {
    const summary = redactSummary(config);
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      assert.equal(typeof (value as { reveal?: unknown }).reveal, "undefined");
      for (const child of Object.values(value)) walk(child);
    };
    walk(summary);
  });

  it("includes every behaviour setting", () => {
    const keys = Object.keys(redactSummary(config)).sort();
    const configKeys = Object.keys(config).sort();
    assert.deepEqual(keys, configKeys);
  });
});
