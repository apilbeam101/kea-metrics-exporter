import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSanitizer, findLeaks, type LeakKind } from "../../src/sanitize.ts";

function kinds(text: string): LeakKind[] {
  return findLeaks(text).map((leak) => leak.kind);
}

describe("findLeaks", () => {
  it("accepts documentation, loopback, link-local and unspecified addresses", () => {
    const text =
      "192.0.2.1 198.51.100.7 203.0.113.250 127.0.0.1 169.254.1.1 0.0.0.0 255.255.255.255 " +
      "2001:db8::1 2001:db8:1:2::/64 ::1 :: fe80::1";
    assert.deepEqual(findLeaks(text), []);
  });

  it("flags RFC 1918, CGNAT and public IPv4 addresses", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "8.8.8.8"]) {
      assert.deepEqual(kinds(`addr ${address}/24`), ["ip"], address);
    }
  });

  it("flags unique-local and global IPv6 addresses", () => {
    for (const address of ["fd12:3456:789a::1", "fc00::1", "2606:4700::1111", "2001:db80::1"]) {
      assert.deepEqual(kinds(`addr ${address}`), ["ip"], address);
    }
  });

  it("does not mistake Kea statistic timestamps for IPv6 addresses", () => {
    assert.deepEqual(findLeaks('[[42, "2026-01-15 09:30:00.123456"]]'), []);
  });

  it("does not mistake Kea statistic names for domains", () => {
    const text = '{"subnet[1].pool[0].assigned-addresses": [], "key[key1].update-sent": []}';
    assert.deepEqual(findLeaks(text), []);
  });

  it("flags MAC addresses outside the RFC 7042 documentation range", () => {
    assert.deepEqual(kinds("hw 0a:1b:2c:3d:4e:5f"), ["mac"]);
    assert.deepEqual(kinds("hw 0A-1B-2C-3D-4E-5F"), ["mac"]);
    assert.deepEqual(findLeaks("hw 00:00:5e:00:53:01"), []);
  });

  it("flags non-example domains and accepts example ones", () => {
    assert.deepEqual(kinds("host kea1.corp.invalid-company.net"), ["domain"]);
    assert.deepEqual(findLeaks("host kea-a.example.com and b.example.net"), []);
  });

  it("flags long base64 or hex runs as tokens", () => {
    assert.deepEqual(kinds(`hash ${"A1".repeat(32)}`), ["token"]);
  });

  it("flags a basic-auth header value", () => {
    assert.deepEqual(kinds("Authorization: Basic dXNlcjpwYXNz"), ["credential"]);
    assert.deepEqual(findLeaks("Authorization: Basic REDACTED"), []);
  });

  it("flags a password-like JSON value", () => {
    assert.deepEqual(kinds('{"password": "hunter2"}'), ["credential"]);
    assert.deepEqual(kinds('{"db": {"api-token": "abc"}}'), ["credential"]);
    assert.deepEqual(findLeaks('{"password": "REDACTED"}'), []);
  });

  it("flags HA server names, scopes, shared networks and key names not in placeholder form", () => {
    const text = JSON.stringify({
      local: { "server-name": "dhcp-north", scopes: ["dhcp-north"] },
      remote: { "server-name": "server2", "last-scopes": ["dhcp-south"] },
      subnets: [{ "shared-network-name": "office-floor-3" }],
      "key[ddns-key.zone].update-sent": [],
    });
    const names = findLeaks(text)
      .filter((leak) => leak.kind === "name")
      .map((leak) => leak.value)
      .sort();
    assert.deepEqual(names, ["ddns-key.zone", "dhcp-north", "dhcp-south", "office-floor-3"]);
  });

  it("accepts placeholder structural names", () => {
    const text = JSON.stringify({
      local: { "server-name": "server1", scopes: ["server1"] },
      subnets: [{ "shared-network-name": "network1" }, { "shared-network-name": "" }],
      "key[key1].update-sent": [],
    });
    assert.deepEqual(findLeaks(text), []);
  });

  it("skips structural checks on non-JSON input without throwing", () => {
    assert.deepEqual(findLeaks("<html>502 Bad Gateway</html>"), []);
  });
});

describe("createSanitizer", () => {
  it("maps each private /24 to a documentation /24, preserving host and prefix length", () => {
    const out = createSanitizer().sanitize("10.20.30.0/24 10.20.30.5 10.20.31.5 172.16.0.1/12");
    assert.equal(out, "192.0.2.0/24 192.0.2.5 198.51.100.5 203.0.113.1/12");
    assert.deepEqual(findLeaks(out), []);
  });

  it("refuses an input spanning more than three IPv4 /24 networks", () => {
    assert.throws(
      () => createSanitizer().sanitize("10.0.1.1 10.0.2.1 10.0.3.1 10.0.4.1"),
      /more than three distinct IPv4/,
    );
  });

  it("maps IPv6 prefixes into 2001:db8::/32, keeping the interface part", () => {
    const out = createSanitizer().sanitize(
      "fd12:3456:789a:1::10 fd12:3456:789a:2::/64 2606:4700::1",
    );
    assert.equal(out, "2001:db8:1:1::10 2001:db8:1:2::/64 2001:db8:2::1");
    assert.deepEqual(findLeaks(out), []);
  });

  it("leaves documentation addresses and timestamps untouched", () => {
    const text = '[[1, "2026-01-15 09:30:00.123456"]] 192.0.2.9 2001:db8::9';
    assert.equal(createSanitizer().sanitize(text), text);
  });

  it("leaves numeric values untouched, including ones above 2^53", () => {
    const text = '{"subnet[10].total-nas": [[18446744073709551616, "2026-01-15 09:30:00.000000"]]}';
    assert.equal(createSanitizer().sanitize(text), text);
  });

  it("renames HA server names consistently across scopes and across inputs", () => {
    const sanitizer = createSanitizer();
    const primary = sanitizer.sanitize(
      JSON.stringify({
        local: { "server-name": "north", scopes: ["north"] },
        remote: { "server-name": "south", "last-scopes": [] },
      }),
    );
    const standby = sanitizer.sanitize(
      JSON.stringify({
        local: { "server-name": "south", scopes: [] },
        remote: { "server-name": "north", "last-scopes": ["north"] },
      }),
    );
    assert.deepEqual(JSON.parse(primary), {
      local: { "server-name": "server1", scopes: ["server1"] },
      remote: { "server-name": "server2", "last-scopes": [] },
    });
    assert.deepEqual(JSON.parse(standby), {
      local: { "server-name": "server2", scopes: [] },
      remote: { "server-name": "server1", "last-scopes": ["server1"] },
    });
  });

  it("does not double-rename a real name that collides with a placeholder", () => {
    const out = createSanitizer().sanitize(
      JSON.stringify({ a: { "server-name": "server2" }, b: { "server-name": "alpha" } }),
    );
    assert.deepEqual(JSON.parse(out), {
      a: { "server-name": "server1" },
      b: { "server-name": "server2" },
    });
  });

  it("renames shared networks and TSIG key names", () => {
    const out = createSanitizer().sanitize(
      JSON.stringify({
        subnets: [{ id: 1, "shared-network-name": "floor-3" }],
        "key[ddns-key.zone].update-sent": [[1, "t"]],
      }),
    );
    assert.deepEqual(JSON.parse(out), {
      subnets: [{ id: 1, "shared-network-name": "network1" }],
      "key[key1].update-sent": [[1, "t"]],
    });
  });

  it("replaces MACs, domains, tokens and credentials with consistent placeholders", () => {
    const sanitizer = createSanitizer();
    const out = sanitizer.sanitize(
      `0a:1b:2c:3d:4e:5f kea1.corp.invalid-company.net ${"ab".repeat(20)} ` +
        `Basic dXNlcjpwYXNz {"password": "hunter2"} 0A:1B:2C:3D:4E:5F kea1.corp.invalid-company.net`,
    );
    assert.equal(
      out,
      "00:00:5e:00:53:00 host1.example.com REDACTED-TOKEN-1 Basic REDACTED " +
        '{"password": "REDACTED"} 00:00:5e:00:53:00 host1.example.com',
    );
    assert.deepEqual(findLeaks(out), []);
  });
});
