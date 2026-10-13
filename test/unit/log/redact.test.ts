import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { errorFields, redactFields } from "../../../src/log/redact.ts";

describe("redactFields", () => {
  it("redacts values under sensitive keys at any depth, whatever their type", () => {
    const out = redactFields({
      password: "p",
      nested: { authorization: "Basic abc", kea_password: { a: 1 }, "api-token": 42 },
      list: [{ secret: "s" }],
    });
    assert.deepEqual(out, {
      password: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        kea_password: "[REDACTED]",
        "api-token": "[REDACTED]",
      },
      list: [{ secret: "[REDACTED]" }],
    });
  });

  it("keeps keys that only describe where a secret came from", () => {
    const source = { kind: "file", variable: "KEA_PASSWORD_FILE", path: "/run/secrets/kea" };
    assert.deepEqual(redactFields({ passwordSource: source }), { passwordSource: source });
  });

  it("replaces a Secret wherever it appears", () => {
    assert.deepEqual(redactFields({ any: new Secret("x"), list: [new Secret("y")] }), {
      any: "[REDACTED]",
      list: ["[REDACTED]"],
    });
  });

  it("cuts cycles instead of following them", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    assert.deepEqual(redactFields(a), { name: "a", self: "[TRUNCATED]" });
  });
});

describe("errorFields", () => {
  it("keeps only the message, the reason and the cause chain's messages", () => {
    const cause = Object.assign(new Error("socket hang up"), {
      request: { headers: { authorization: "Basic abc" } },
    });
    const error = new KeaHttpError("network", "status-get request failed", { cause });
    const fields = errorFields(error);
    assert.deepEqual(fields, {
      error: "status-get request failed",
      reason: "network",
      causes: ["Error: socket hang up"],
    });
    assert.equal(JSON.stringify(fields).includes("abc"), false);
  });

  it("handles a thrown non-error", () => {
    assert.deepEqual(errorFields("boom"), { error: "boom" });
  });
});
