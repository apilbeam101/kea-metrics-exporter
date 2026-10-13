import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeHost } from "../../src/healthcheck.ts";

describe("probeHost", () => {
  it("probes loopback when the listener is bound to every interface", () => {
    assert.equal(probeHost(undefined), "127.0.0.1");
    assert.equal(probeHost(""), "127.0.0.1");
    assert.equal(probeHost("0.0.0.0"), "127.0.0.1");
    assert.equal(probeHost("::"), "::1");
  });

  it("probes the bound address otherwise", () => {
    assert.equal(probeHost("192.0.2.5"), "192.0.2.5");
    assert.equal(probeHost("::1"), "::1");
  });
});
