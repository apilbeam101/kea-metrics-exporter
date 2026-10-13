import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeaHttpError, reasonOfError } from "../../../src/http/errors.ts";

describe("reasonOfError", () => {
  it("returns a KeaHttpError's own reason", () => {
    assert.equal(reasonOfError(new KeaHttpError("too_large", "x")), "too_large");
  });

  it("classifies a TypeError as a parse failure", () => {
    assert.equal(reasonOfError(new TypeError("x is undefined")), "parse");
  });

  it("classifies anything else as unknown", () => {
    assert.equal(reasonOfError(new Error("x")), "unknown");
    assert.equal(reasonOfError("not an error"), "unknown");
  });
});
