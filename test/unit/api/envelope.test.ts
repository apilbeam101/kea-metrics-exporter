import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classify, expectOk, toError } from "../../../src/api/envelope.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "test", "fixtures", "envelope", name), "utf8");
}

const ok = (body: string, statusCode = 200) => classify({ statusCode, body });

describe("classify", () => {
  it("returns arguments and text for result 0", () => {
    const envelope = ok(JSON.stringify([{ result: 0, text: "fine", arguments: { a: 1 } }]));
    assert.deepEqual(envelope, { kind: "ok", arguments: { a: 1 }, text: "fine" });
  });

  it("treats result 2 as unsupported and result 3 as empty, not as errors", () => {
    assert.equal(ok(fixture("unsupported.json")).kind, "unsupported");
    assert.equal(ok(fixture("empty.json")).kind, "empty");
  });

  it("treats results 1, 4, 5 and unknown hook codes as api errors", () => {
    for (const result of [1, 4, 5, 1000]) {
      const envelope = ok(JSON.stringify([{ result, text: "no" }]));
      assert.deepEqual(envelope, { kind: "api-error", result, text: "no" });
    }
  });

  it("classifies the bare 403 object as auth, whatever the HTTP status", () => {
    assert.equal(ok(fixture("auth-forbidden.json"), 403).kind, "auth");
    assert.equal(ok(fixture("auth-forbidden.json"), 200).kind, "auth");
    assert.equal(ok(JSON.stringify({ result: 401, text: "Unauthorized" }), 401).kind, "auth");
  });

  it("classifies the bare 401 object Kea 3.2 returns for a wrong password as auth", () => {
    assert.equal(ok(fixture("auth-unauthorized.json"), 401).kind, "auth");
  });

  it("classifies a 401 or 403 with a non-JSON body as auth", () => {
    assert.equal(ok("Unauthorized", 401).kind, "auth");
    assert.equal(ok("", 403).kind, "auth");
  });

  it("classifies a non-2xx, non-auth response as an HTTP error", () => {
    assert.deepEqual(ok(fixture("not-json.txt"), 404), { kind: "http-error", statusCode: 404 });
    assert.deepEqual(ok(fixture("success.json"), 302), { kind: "http-error", statusCode: 302 });
  });

  it("rejects malformed shapes rather than guessing", () => {
    assert.equal(ok(fixture("not-json.txt")).kind, "malformed");
    assert.equal(ok(fixture("two-element.json")).kind, "malformed");
    assert.equal(ok(fixture("missing-result.json")).kind, "malformed");
    assert.equal(ok("[]").kind, "malformed");
    assert.equal(ok(JSON.stringify({ result: 0 })).kind, "malformed");
    assert.equal(ok(JSON.stringify([{ result: "0" }])).kind, "malformed");
    assert.equal(ok(JSON.stringify([{ result: 0.5 }])).kind, "malformed");
  });

  it("bounds error text so it cannot flood a log line", () => {
    const envelope = ok(JSON.stringify([{ result: 1, text: "x".repeat(5000) }]));
    assert.ok(envelope.kind === "api-error" && (envelope.text?.length ?? 0) <= 201);
  });
});

describe("toError and expectOk", () => {
  const reason = (body: string, statusCode = 200) => {
    try {
      expectOk("status-get", { statusCode, body });
    } catch (error) {
      assert.ok(error instanceof KeaHttpError);
      return error.reason;
    }
    assert.fail("expected expectOk to throw");
  };

  it("maps each non-ok classification to its poll error reason", () => {
    assert.equal(reason(fixture("auth-forbidden.json"), 403), "auth");
    assert.equal(reason("nope", 404), "http_4xx");
    assert.equal(reason("", 302), "unknown");
    assert.equal(reason(fixture("not-json.txt")), "parse");
    assert.equal(reason(fixture("error.json")), "api_error");
    assert.equal(reason(fixture("unsupported.json")), "api_error");
    assert.equal(reason(fixture("empty.json")), "api_error");
  });

  it("returns the arguments of a successful answer", () => {
    const args = expectOk("status-get", {
      statusCode: 200,
      body: JSON.stringify([{ result: 0, arguments: { pid: 1 } }]),
    });
    assert.deepEqual(args, { pid: 1 });
  });

  it("names the command in the error message", () => {
    const error = toError("config-hash-get", { kind: "auth" });
    assert.match(error.message, /^config-hash-get: /);
  });
});
