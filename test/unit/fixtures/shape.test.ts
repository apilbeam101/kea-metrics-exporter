import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const FIXTURES = join(process.cwd(), "test", "fixtures");

function raw(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function load(path: string): unknown {
  return JSON.parse(raw(path));
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function single(path: string): Obj {
  const parsed = load(path);
  assert.ok(Array.isArray(parsed), `${path} is not an array`);
  assert.equal(parsed.length, 1, `${path} is not a one-element array`);
  const [element] = parsed;
  assert.ok(isObj(element));
  assert.equal(typeof element.result, "number");
  return element;
}

function args(path: string): Obj {
  const element = single(path);
  assert.equal(element.result, 0);
  assert.ok(isObj(element.arguments), `${path} has no arguments`);
  return element.arguments;
}

function files(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir)).map((file) => `${dir}/${file}`);
}

const HA_STATES = [
  "backup",
  "communication-recovery",
  "hot-standby",
  "in-maintenance",
  "load-balancing",
  "partner-down",
  "partner-in-maintenance",
  "passive-backup",
  "ready",
  "syncing",
  "terminated",
  "unavailable",
  "waiting",
];
const HA_MODES = ["load-balancing", "hot-standby", "passive-backup"];
const HA_ROLES = ["primary", "secondary", "standby", "backup"];
const SOCKET_STATUSES = ["ready", "retrying", "failed"];
const SAMPLE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

describe("envelope fixtures", () => {
  it("cover each result code as a one-element array", () => {
    for (const [file, code] of [
      ["success.json", 0],
      ["error.json", 1],
      ["unsupported.json", 2],
      ["empty.json", 3],
    ] as const) {
      assert.equal(single(`envelope/${file}`).result, code);
    }
  });

  it("include both bare-object authentication failures", () => {
    for (const [file, code] of [
      ["envelope/auth-forbidden.json", 403],
      ["envelope/auth-unauthorized.json", 401],
    ] as const) {
      const parsed = load(file);
      assert.ok(isObj(parsed));
      assert.equal(parsed.result, code);
    }
  });

  it("include the malformed shapes", () => {
    const twoElement = load("envelope/two-element.json");
    assert.ok(Array.isArray(twoElement) && twoElement.length === 2);
    const [missing] = load("envelope/missing-result.json") as unknown[];
    assert.ok(isObj(missing) && !("result" in missing));
    assert.throws(() => JSON.parse(raw("envelope/not-json.txt")));
  });
});

describe("version fixtures", () => {
  it("carry the version in text, with and without extended arguments", () => {
    assert.equal(single("version/version-get-extended.json").text, "3.2.0");
    assert.ok(isObj(single("version/version-get-extended.json").arguments));
    assert.equal(single("version/version-get-text-only.json").arguments, undefined);
    assert.match(String(single("version/version-get-2x.json").text), /^2\./);
  });
});

describe("status fixtures", () => {
  it("carry the process fields on every daemon", () => {
    for (const file of [...files("status"), ...files("ha")]) {
      const a = args(file);
      for (const key of ["pid", "uptime", "reload"]) {
        assert.equal(typeof a[key], "number", `${file}: ${key}`);
      }
    }
  });

  it("carry DHCP-only fields on DHCPv4 targets and not on the DDNS daemon", () => {
    for (const file of files("status").filter((f) => f.includes("dhcp4"))) {
      const a = args(file);
      assert.ok(isObj(a["dhcp-state"]), file);
      assert.ok(isObj(a.sockets) && SOCKET_STATUSES.includes(String(a.sockets.status)), file);
      assert.equal(typeof a["multi-threading-enabled"], "boolean", file);
    }
    const d2 = args("status/d2.json");
    for (const key of ["dhcp-state", "sockets", "multi-threading-enabled", "high-availability"]) {
      assert.equal(key in d2, false, key);
    }
  });

  it("omit thread-pool and queue fields when multi-threading is off", () => {
    const a = args("status/dhcp4-mt-off.json");
    assert.equal(a["multi-threading-enabled"], false);
    for (const key of ["thread-pool-size", "packet-queue-size", "packet-queue-statistics"]) {
      assert.equal(key in a, false, key);
    }
  });

  it("cover every socket status, with errors only when not ready", () => {
    const seen = new Set<string>();
    for (const file of files("status").filter((f) => f.includes("dhcp4"))) {
      const sockets = args(file).sockets as Obj;
      seen.add(String(sockets.status));
      assert.equal(sockets.status === "ready", sockets.errors === undefined, file);
    }
    assert.deepEqual([...seen].sort(), [...SOCKET_STATUSES].sort());
  });

  it("set every disabled origin in the disabled fixture", () => {
    const state = args("status/dhcp4-disabled.json")["dhcp-state"] as Obj;
    assert.equal(state["globally-disabled"], true);
    assert.equal(state["disabled-by-user"], true);
    for (const key of [
      "disabled-by-local-command",
      "disabled-by-remote-command",
      "disabled-by-db-connection",
    ]) {
      assert.ok(Array.isArray(state[key]) && (state[key] as unknown[]).length > 0, key);
    }
  });
});

interface Relationship {
  mode: string;
  local: Obj;
  remote: Obj | undefined;
}

function relationships(file: string): Relationship[] {
  const ha = args(file)["high-availability"];
  assert.ok(Array.isArray(ha), `${file} has no high-availability array`);
  return ha.map((entry: unknown) => {
    assert.ok(isObj(entry) && isObj(entry["ha-servers"]));
    const servers = entry["ha-servers"];
    assert.ok(isObj(servers.local));
    assert.ok(servers.remote === undefined || isObj(servers.remote));
    return {
      mode: String(entry["ha-mode"]),
      local: servers.local,
      remote: servers.remote as Obj | undefined,
    };
  });
}

describe("HA fixtures", () => {
  it("use only documented modes and roles, with string server names and scope lists", () => {
    for (const file of files("ha")) {
      for (const rel of relationships(file)) {
        assert.ok(HA_MODES.includes(rel.mode), `${file}: ${rel.mode}`);
        for (const side of [rel.local, rel.remote]) {
          if (side === undefined) continue;
          assert.ok(HA_ROLES.includes(String(side.role)), file);
          assert.equal(typeof side["server-name"], "string", file);
        }
        assert.ok(Array.isArray(rel.local.scopes), file);
        if (rel.remote !== undefined) assert.ok(Array.isArray(rel.remote["last-scopes"]), file);
      }
    }
  });

  it("form a matched hot-standby pair viewed from both sides", () => {
    const [primary] = relationships("ha/hot-standby-primary.json");
    const [standby] = relationships("ha/hot-standby-standby.json");
    assert.ok(primary?.remote && standby?.remote);
    assert.equal(primary.local["server-name"], standby.remote["server-name"]);
    assert.equal(standby.local["server-name"], primary.remote["server-name"]);
  });

  it("include an interrupted relationship with non-zero failover counters", () => {
    const [rel] = relationships("ha/load-balancing-interrupted.json");
    assert.equal(rel?.remote?.["communication-interrupted"], true);
    for (const key of ["connecting-clients", "unacked-clients", "unacked-clients-left"]) {
      assert.ok(Number(rel?.remote?.[key]) > 0, key);
    }
  });

  it("include a hub with two relationships and a passive-backup with no remote", () => {
    assert.equal(relationships("ha/hub-two-relationships.json").length, 2);
    const [backup] = relationships("ha/passive-backup.json");
    assert.equal(backup?.remote, undefined);
  });

  it("include an unrecognised state", () => {
    const [rel] = relationships("ha/unknown-state.json");
    assert.equal(HA_STATES.includes(String(rel?.local.state)), false);
  });

  it("cover all thirteen HA states, locally and as a partner's last state", () => {
    const local = new Set<string>();
    const remote = new Set<string>();
    for (const file of files("ha")) {
      for (const rel of relationships(file)) {
        local.add(String(rel.local.state));
        if (rel.remote !== undefined) remote.add(String(rel.remote["last-state"]));
      }
    }
    for (const state of HA_STATES) {
      assert.ok(local.has(state), `local ${state}`);
      assert.ok(remote.has(state), `remote ${state}`);
    }
  });
});

function statistics(file: string): Obj {
  return args(file);
}

describe("statistics fixtures", () => {
  it("hold sample lists of [number, timestamp] pairs, newest first", () => {
    for (const file of files("statistics")) {
      for (const [name, samples] of Object.entries(statistics(file))) {
        assert.ok(Array.isArray(samples), `${file}: ${name}`);
        for (const sample of samples) {
          assert.ok(Array.isArray(sample) && sample.length === 2, `${file}: ${name}`);
          assert.equal(typeof sample[0], "number", `${file}: ${name}`);
          assert.match(String(sample[1]), SAMPLE_TIMESTAMP, `${file}: ${name}`);
        }
        const times = samples.map((sample: unknown[]) => String(sample[1]));
        assert.deepEqual(times, [...times].sort().reverse(), `${file}: ${name} not newest first`);
      }
    }
  });

  it("cover the DHCPv4 hazards", () => {
    const stats = statistics("statistics/dhcp4.json");
    assert.equal((stats["pkt4-received"] as unknown[]).length, 20);
    assert.equal((stats["pkt4-request-received"] as unknown[]).length, 1);
    assert.deepEqual(stats["pkt4-lease-query-received"], []);
    assert.equal("pkt4-inform-received" in stats, false);
    assert.ok("pkt4-hypothetical-new-counter" in stats);
    assert.ok("subnet[2].pool[1].future-stat" in stats);
    assert.ok(Object.keys(stats).some((name) => /^subnet\[\d+\]\.pool\[\d+\]\./.test(name)));
  });

  it("cover DHCPv6 address and prefix pools, and a value above 2^53 kept exact on disk", () => {
    const stats = statistics("statistics/dhcp6.json");
    assert.ok(Object.keys(stats).some((name) => name.includes(".pool[0].")));
    assert.ok(Object.keys(stats).some((name) => name.includes(".pd-pool[0].")));
    assert.match(raw("statistics/dhcp6.json"), /\b18446744073709551616\b/);
  });

  it("cover DDNS global and per-key statistics", () => {
    const names = Object.keys(statistics("statistics/d2.json"));
    assert.ok(names.includes("ncr-received"));
    assert.ok(names.some((name) => /^key\[key\d+\]\.update-/.test(name)));
  });
});

describe("subnet and config-hash fixtures", () => {
  it("list subnets with integer IDs, CIDR prefixes and optional shared networks", () => {
    for (const file of ["subnets/subnet4-list.json", "subnets/subnet6-list.json"]) {
      const subnets = args(file).subnets;
      assert.ok(Array.isArray(subnets) && subnets.length > 0, file);
      for (const subnet of subnets) {
        assert.ok(isObj(subnet) && Number.isInteger(subnet.id), file);
        assert.match(String(subnet.subnet), /\/\d+$/, file);
      }
    }
    const v4 = args("subnets/subnet4-list.json").subnets as Obj[];
    assert.ok(v4.some((s) => s["shared-network-name"] === undefined));
    assert.ok(v4.some((s) => typeof s["shared-network-name"] === "string"));
  });

  it("include the hook-absent and no-subnet results", () => {
    assert.equal(single("subnets/subnet4-list-unsupported.json").result, 2);
    assert.equal(single("subnets/subnet4-list-empty.json").result, 3);
  });

  it("provide two different configuration hashes", () => {
    const a = args("config-hash/hash-a.json").hash;
    const b = args("config-hash/hash-b.json").hash;
    assert.equal(typeof a, "string");
    assert.notEqual(a, b);
  });
});
