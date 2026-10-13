import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../../../src/api/envelope.ts";
import { isVersionSupported, parseVersion } from "../../../src/api/version.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { answer, fixture } from "../../support/fake-kea-client.ts";

function parse(response: ReturnType<typeof fixture>): string {
  const envelope = classify(response);
  assert.equal(envelope.kind, "ok");
  return parseVersion(envelope as Extract<typeof envelope, { kind: "ok" }>);
}

describe("parseVersion", () => {
  it("reads the version from text, with or without extended arguments", () => {
    assert.equal(parse(fixture("version/version-get-extended.json")), "3.2.0");
    assert.equal(parse(fixture("version/version-get-text-only.json")), "3.2.0");
    assert.equal(parse(fixture("version/version-get-2x.json")), "2.6.3");
  });

  it("falls back to the leading token of arguments.extended", () => {
    assert.equal(parse(answer(0, { extended: "3.2.1 (tarball)\nlinked with: x" })), "3.2.1");
  });

  it("keeps a pre-release suffix but no build detail", () => {
    assert.equal(parse(answer(0, undefined, "3.3.0-git (isc20260101)")), "3.3.0-git");
  });

  it("fails when neither place holds a version", () => {
    assert.throws(
      () => parse(answer(0, { extended: "unknown" }, "no version here")),
      (error: unknown) => error instanceof KeaHttpError && error.reason === "parse",
    );
  });
});

describe("isVersionSupported", () => {
  it("supports 3.0 and later only", () => {
    assert.equal(isVersionSupported("3.0.0"), true);
    assert.equal(isVersionSupported("3.2.0"), true);
    assert.equal(isVersionSupported("4.0.0"), true);
    assert.equal(isVersionSupported("2.6.3"), false);
    assert.equal(isVersionSupported("garbage"), false);
  });
});
