import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { redactSummary } from "../../../src/config/redact-summary.ts";
import { ConfigError, type ValidateDeps, validate } from "../../../src/config/validate.ts";

const PASSWORD = "correct-horse-battery-staple";

const BASE = {
  KEA_TARGETS: "dhcp4-a=https://kea-a.example.com:8004",
  KEA_DAEMON: "dhcp4",
  KEA_USERNAME: "metrics",
  KEA_PASSWORD: PASSWORD,
} as const;

function files(map: Record<string, string>): ValidateDeps {
  return {
    readFile: (path) => {
      const content = map[path];
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
  };
}

const noFiles = files({});

function errorOf(vars: Record<string, string | undefined>, deps: ValidateDeps = noFiles): string {
  try {
    validate(vars, deps);
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return error.message;
  }
  assert.fail("expected validation to fail");
}

describe("validate: defaults and targets", () => {
  it("accepts a minimal configuration and applies every default", () => {
    const { config, warnings } = validate(BASE, noFiles);
    assert.deepEqual(warnings, []);
    assert.equal(config.targets.length, 1);
    const [target] = config.targets;
    assert.equal(target?.name, "dhcp4-a");
    assert.equal(target?.baseUrl, "https://kea-a.example.com:8004");
    assert.equal(target?.daemon, "dhcp4");
    assert.equal(target?.username, "metrics");
    assert.equal(target?.password.reveal(), PASSWORD);
    assert.deepEqual(target?.passwordSource, { kind: "env", variable: "KEA_PASSWORD" });
    assert.equal(target?.caBundlePath, undefined);
    assert.equal(target?.tlsInsecureSkipVerify, false);
    assert.equal(config.metricsPort, 10167);
    assert.equal(config.metricsBindAddress, "0.0.0.0");
    assert.equal(config.pollIntervalSeconds, 30);
    assert.equal(config.requestTimeoutSeconds, 15);
    assert.equal(config.maxResponseBytes, 64 * 1024 * 1024);
    assert.equal(config.maxSubnets, 2048);
    assert.equal(config.enablePoolStats, true);
    assert.equal(config.enableSubnetLabels, false);
    assert.equal(config.enableD2KeyStats, false);
    assert.equal(config.enableDefaultMetrics, true);
    assert.equal(config.logLevel, "info");
    assert.equal(config.logFormat, "json");
    assert.equal(config.metricsTls, undefined);
  });

  it("resolves per-target overrides for every per-target setting", () => {
    const { config } = validate(
      {
        ...BASE,
        KEA_TARGETS: "dhcp4-a=https://kea-a.example.com:8004,dhcp6-a=https://[2001:db8::10]:8006",
        KEA_DAEMON__DHCP6_A: "dhcp6",
        KEA_USERNAME__DHCP6_A: "metrics-v6",
        KEA_CA_BUNDLE_PATH: "/etc/kea-exporter/ca.pem",
        KEA_CA_BUNDLE_PATH__DHCP6_A: "/etc/kea-exporter/ca-v6.pem",
        KEA_CLIENT_CERT_PATH__DHCP6_A: "/etc/kea-exporter/client.pem",
        KEA_CLIENT_KEY_PATH__DHCP6_A: "/etc/kea-exporter/client-key.pem",
        KEA_TLS_INSECURE_SKIP_VERIFY__DHCP4_A: "true",
      },
      noFiles,
    );
    const [v4, v6] = config.targets;
    assert.equal(v4?.daemon, "dhcp4");
    assert.equal(v4?.username, "metrics");
    assert.equal(v4?.caBundlePath, "/etc/kea-exporter/ca.pem");
    assert.equal(v4?.tlsInsecureSkipVerify, true);
    assert.equal(v4?.clientCertPath, undefined);
    assert.equal(v6?.baseUrl, "https://[2001:db8::10]:8006");
    assert.equal(v6?.daemon, "dhcp6");
    assert.equal(v6?.username, "metrics-v6");
    assert.equal(v6?.caBundlePath, "/etc/kea-exporter/ca-v6.pem");
    assert.equal(v6?.clientCertPath, "/etc/kea-exporter/client.pem");
    assert.equal(v6?.clientKeyPath, "/etc/kea-exporter/client-key.pem");
    assert.equal(v6?.tlsInsecureSkipVerify, false);
  });

  it("accepts a daemon type case-insensitively", () => {
    const { config } = validate({ ...BASE, KEA_DAEMON: "D2" }, noFiles);
    assert.equal(config.targets[0]?.daemon, "d2");
  });

  it("accepts a base URL with a path prefix, for a reverse proxy", () => {
    const { config } = validate(
      { ...BASE, KEA_TARGETS: "dhcp4-a=https://proxy.example.com/kea/dhcp4" },
      noFiles,
    );
    assert.equal(config.targets[0]?.baseUrl, "https://proxy.example.com/kea/dhcp4");
  });

  it("requires KEA_TARGETS", () => {
    assert.match(errorOf({ ...BASE, KEA_TARGETS: undefined }), /KEA_TARGETS is required/);
  });

  it("rejects empty, malformed and invalidly named target entries", () => {
    const message = errorOf({
      ...BASE,
      KEA_TARGETS: "dhcp4-a=https://kea-a.example.com,,no-equals,-bad=https://x.example.com",
    });
    assert.match(message, /empty entry/);
    assert.match(message, /"no-equals" is not in the form name=url/);
    assert.match(message, /target name "-bad" is invalid/);
  });

  it("rejects a base URL with a query string, a fragment, or no scheme", () => {
    for (const url of [
      "https://kea-a.example.com/?x=1",
      "https://kea-a.example.com/#frag",
      "kea-a.example.com:8004",
      "ftp://kea-a.example.com",
    ]) {
      assert.match(errorOf({ ...BASE, KEA_TARGETS: `dhcp4-a=${url}` }), /invalid base URL/, url);
    }
  });

  it("rejects credentials in the URL without echoing them", () => {
    const message = errorOf({
      ...BASE,
      KEA_TARGETS: "dhcp4-a=https://metrics:urlpass@kea-a.example.com:8004",
    });
    assert.match(message, /credentials in its URL/);
    assert.equal(message.includes("urlpass"), false);
  });

  it("rejects duplicate names case-insensitively, and names colliding on override suffix", () => {
    assert.match(
      errorOf({ ...BASE, KEA_TARGETS: "a=https://a.example.com,A=https://b.example.com" }),
      /duplicate target name "A"/,
    );
    assert.match(
      errorOf({ ...BASE, KEA_TARGETS: "a-b=https://a.example.com,a_b=https://b.example.com" }),
      /both resolve to override suffix "A_B"/,
    );
  });

  it("rejects an override naming no configured target", () => {
    assert.match(
      errorOf({ ...BASE, KEA_PASSWORD__DHCP4_TYPO: "x" }),
      /KEA_PASSWORD__DHCP4_TYPO does not match any configured target name/,
    );
  });

  it("rejects a wrong-case override and suggests the canonical key", () => {
    assert.match(
      errorOf({ ...BASE, kea_daemon__dhcp4_a: "dhcp4" }),
      /did you mean "KEA_DAEMON__DHCP4_A"/,
    );
  });

  it("reports a dropped target's override against the real cause, not as an orphan", () => {
    const message = errorOf({
      ...BASE,
      KEA_TARGETS: "dhcp4-a=not-a-url",
      KEA_DAEMON__DHCP4_A: "dhcp4",
    });
    assert.match(message, /invalid base URL/);
    assert.equal(message.includes("does not match any configured target"), false);
  });
});

describe("validate: daemon and credentials", () => {
  it("requires a daemon type and rejects an unknown one", () => {
    assert.match(errorOf({ ...BASE, KEA_DAEMON: undefined }), /has no daemon type/);
    assert.match(errorOf({ ...BASE, KEA_DAEMON: "ctrl-agent" }), /KEA_DAEMON must be one of/);
  });

  it("requires a username without a colon", () => {
    assert.match(errorOf({ ...BASE, KEA_USERNAME: undefined }), /has no username/);
    assert.match(errorOf({ ...BASE, KEA_USERNAME: "a:b" }), /must not contain ":"/);
  });

  it("requires a password", () => {
    assert.match(errorOf({ ...BASE, KEA_PASSWORD: undefined }), /has no password/);
  });

  it("reads the password from a file, stripping only the trailing line terminator", () => {
    const { config } = validate(
      { ...BASE, KEA_PASSWORD: undefined, KEA_PASSWORD_FILE: "/run/secrets/kea" },
      files({ "/run/secrets/kea": ` ${PASSWORD} \r\n` }),
    );
    assert.equal(config.targets[0]?.password.reveal(), ` ${PASSWORD} `);
    assert.deepEqual(config.targets[0]?.passwordSource, {
      kind: "file",
      variable: "KEA_PASSWORD_FILE",
      path: "/run/secrets/kea",
    });
  });

  it("rejects an empty or unreadable password file, naming the variable and error code only", () => {
    const vars = { ...BASE, KEA_PASSWORD: undefined, KEA_PASSWORD_FILE: "/run/secrets/kea" };
    assert.match(errorOf(vars, files({ "/run/secrets/kea": "\n" })), /names an empty file/);
    const unreadable = errorOf(vars, noFiles);
    assert.match(unreadable, /KEA_PASSWORD_FILE could not be read \(ENOENT\)/);
  });

  it("rejects both password forms in the same scope", () => {
    assert.match(
      errorOf({ ...BASE, KEA_PASSWORD_FILE: "/run/secrets/kea" }),
      /KEA_PASSWORD and KEA_PASSWORD_FILE are mutually exclusive/,
    );
    assert.match(
      errorOf({ ...BASE, KEA_PASSWORD__DHCP4_A: "x", KEA_PASSWORD_FILE__DHCP4_A: "/f" }),
      /KEA_PASSWORD__DHCP4_A and KEA_PASSWORD_FILE__DHCP4_A are mutually exclusive/,
    );
  });

  it("lets a per-target password of either form replace both global forms", () => {
    const { config } = validate(
      {
        ...BASE,
        KEA_TARGETS: "dhcp4-a=https://a.example.com,dhcp4-b=https://b.example.com",
        KEA_PASSWORD: undefined,
        KEA_PASSWORD_FILE: "/run/secrets/shared",
        KEA_PASSWORD__DHCP4_B: "inline-b",
      },
      files({ "/run/secrets/shared": "shared-secret\n" }),
    );
    assert.equal(config.targets[0]?.password.reveal(), "shared-secret");
    assert.equal(config.targets[1]?.password.reveal(), "inline-b");
    assert.deepEqual(config.targets[1]?.passwordSource, {
      kind: "env",
      variable: "KEA_PASSWORD__DHCP4_B",
    });
  });

  it("requires a client certificate and key together", () => {
    assert.match(
      errorOf({ ...BASE, KEA_CLIENT_CERT_PATH: "/etc/client.pem" }),
      /KEA_CLIENT_CERT_PATH and KEA_CLIENT_KEY_PATH must both be set, or neither/,
    );
  });
});

describe("validate: TLS, warnings and behaviour settings", () => {
  it("warns about plain http and disabled verification", () => {
    const { warnings } = validate(
      {
        ...BASE,
        KEA_TARGETS: "dhcp4-a=http://kea-a.example.com:8004,dhcp4-b=https://kea-b.example.com",
        KEA_TLS_INSECURE_SKIP_VERIFY__DHCP4_B: "TRUE",
      },
      noFiles,
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /dhcp4-a use plain http/);
    assert.match(warnings[1] ?? "", /verification disabled for target\(s\): dhcp4-b/);
  });

  it("rejects an invalid boolean, naming the variable", () => {
    assert.match(
      errorOf({ ...BASE, KEA_TLS_INSECURE_SKIP_VERIFY: "yes" }),
      /KEA_TLS_INSECURE_SKIP_VERIFY must be "true" or "false"/,
    );
    assert.match(errorOf({ ...BASE, ENABLE_POOL_STATS: "1" }), /ENABLE_POOL_STATS must be/);
  });

  it("enforces the poll interval floor and the numeric bounds", () => {
    assert.match(errorOf({ ...BASE, POLL_INTERVAL_SECONDS: "4" }), /between 5 and 86400/);
    assert.match(errorOf({ ...BASE, MAX_RESPONSE_BYTES: "1024" }), /MAX_RESPONSE_BYTES must be/);
    assert.match(errorOf({ ...BASE, MAX_SUBNETS: "0" }), /MAX_SUBNETS must be/);
    assert.match(errorOf({ ...BASE, METRICS_PORT: "70000" }), /METRICS_PORT must be/);
    assert.match(errorOf({ ...BASE, REQUEST_TIMEOUT_SECONDS: "-1" }), /positive integer/);
  });

  it("parses the behaviour flags and listener settings", () => {
    const { config } = validate(
      {
        ...BASE,
        METRICS_PORT: "9999",
        METRICS_BIND_ADDRESS: "::",
        ENABLE_POOL_STATS: "false",
        ENABLE_SUBNET_LABELS: "true",
        ENABLE_D2_KEY_STATS: "true",
        ENABLE_DEFAULT_METRICS: "false",
        LOG_LEVEL: "DEBUG",
        LOG_FORMAT: "text",
        METRICS_TLS_CERT_PATH: "/etc/tls/cert.pem",
        METRICS_TLS_KEY_PATH: "/etc/tls/key.pem",
        METRICS_TLS_MIN_VERSION: "tlsv1.3",
      },
      noFiles,
    );
    assert.equal(config.metricsPort, 9999);
    assert.equal(config.metricsBindAddress, "::");
    assert.equal(config.enablePoolStats, false);
    assert.equal(config.enableSubnetLabels, true);
    assert.equal(config.enableD2KeyStats, true);
    assert.equal(config.enableDefaultMetrics, false);
    assert.equal(config.logLevel, "debug");
    assert.equal(config.logFormat, "text");
    assert.deepEqual(config.metricsTls, {
      certPath: "/etc/tls/cert.pem",
      keyPath: "/etc/tls/key.pem",
      clientCaPath: undefined,
      minVersion: "TLSv1.3",
    });
  });

  it("rejects a half-configured metrics listener TLS and an invalid bind address", () => {
    assert.match(errorOf({ ...BASE, METRICS_TLS_CERT_PATH: "/c" }), /must both be set, or neither/);
    assert.match(
      errorOf({ ...BASE, METRICS_TLS_CLIENT_CA_PATH: "/ca" }),
      /requires METRICS_TLS_CERT_PATH/,
    );
    assert.match(errorOf({ ...BASE, METRICS_BIND_ADDRESS: "localhost" }), /METRICS_BIND_ADDRESS/);
  });

  it("reports every error at once rather than the first", () => {
    const message = errorOf({
      KEA_TARGETS: "dhcp4-a=https://a.example.com",
      POLL_INTERVAL_SECONDS: "1",
      LOG_LEVEL: "loud",
    });
    for (const fragment of [
      "no daemon type",
      "no username",
      "no password",
      "POLL_INTERVAL_SECONDS",
      "LOG_LEVEL",
    ]) {
      assert.ok(message.includes(fragment), fragment);
    }
  });

  it("returns a deeply frozen configuration", () => {
    const { config } = validate(BASE, noFiles);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.targets));
    assert.ok(Object.isFrozen(config.targets[0]));
    assert.ok(Object.isFrozen(config.targets[0]?.passwordSource));
  });
});

describe("validate: no password can leak (N5)", () => {
  const sources: Array<[string, Record<string, string | undefined>, ValidateDeps]> = [
    ["KEA_PASSWORD", BASE, noFiles],
    [
      "KEA_PASSWORD__DHCP4_A",
      { ...BASE, KEA_PASSWORD: undefined, KEA_PASSWORD__DHCP4_A: PASSWORD },
      noFiles,
    ],
    [
      "KEA_PASSWORD_FILE",
      { ...BASE, KEA_PASSWORD: undefined, KEA_PASSWORD_FILE: "/run/secrets/kea" },
      files({ "/run/secrets/kea": `${PASSWORD}\n` }),
    ],
    [
      "KEA_PASSWORD_FILE__DHCP4_A",
      { ...BASE, KEA_PASSWORD: undefined, KEA_PASSWORD_FILE__DHCP4_A: "/run/secrets/kea" },
      files({ "/run/secrets/kea": PASSWORD }),
    ],
  ];

  for (const [label, vars, deps] of sources) {
    it(`keeps a password from ${label} out of the summary and an inspected config`, () => {
      const { config } = validate(vars, deps);
      assert.equal(config.targets[0]?.password.reveal(), PASSWORD);
      const summary = redactSummary(config);
      for (const rendered of [
        JSON.stringify(summary),
        inspect(summary, { depth: 10 }),
        JSON.stringify(config),
        inspect(config, { depth: 10 }),
      ]) {
        assert.equal(rendered.includes(PASSWORD), false);
      }
      assert.match(JSON.stringify(summary), /\[REDACTED\]/);
    });

    it(`keeps a password from ${label} out of a thrown error`, () => {
      const message = errorOf({ ...vars, LOG_LEVEL: "loud", KEA_DAEMON: "nonsense" }, deps);
      assert.equal(message.includes(PASSWORD), false);
    });
  }
});
