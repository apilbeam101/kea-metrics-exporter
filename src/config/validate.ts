import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { deepFreeze } from "./deep-freeze.ts";
import { Secret } from "./secret.ts";
import {
  type AppConfig,
  DAEMONS,
  type Daemon,
  type LogFormat,
  type LogLevel,
  type MetricsTlsConfig,
  type PasswordSource,
  type TargetConfig,
  type TlsMinVersion,
} from "./types.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface ValidationResult {
  readonly config: AppConfig;
  readonly warnings: readonly string[];
}

export interface ValidateDeps {
  readonly readFile: (path: string) => string;
}

const defaultDeps: ValidateDeps = { readFile: (path) => readFileSync(path, "utf8") };

type EnvVars = Readonly<Record<string, string | undefined>>;

export const DEFAULT_METRICS_PORT = 10167;

// D§6.1: case-insensitive, must start with an alphanumeric.
const TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

// The client appends "/" to this string rather than parsing it, so a query
// string or fragment would swallow the request path. Userinfo is rejected
// separately, with its own message, because it would put a credential into
// every log line that names the target.
const BASE_URL_PATTERN = /^(https?):\/\/([^\s/?#]+)([^\s?#]*)$/i;

const PER_TARGET_VARIABLES = [
  "DAEMON",
  "USERNAME",
  "PASSWORD",
  "PASSWORD_FILE",
  "CA_BUNDLE_PATH",
  "CLIENT_CERT_PATH",
  "CLIENT_KEY_PATH",
  "TLS_INSECURE_SKIP_VERIFY",
] as const;
type PerTargetVariable = (typeof PER_TARGET_VARIABLES)[number];

// Case-insensitive so that a wrong-case override is still recognised as an
// override attempt and rejected loudly, rather than silently ignored.
const OVERRIDE_PATTERN = new RegExp(`^KEA_(${PER_TARGET_VARIABLES.join("|")})__(.+)$`, "i");

function overrideSuffixFor(targetName: string): string {
  return targetName.toUpperCase().replace(/-/g, "_");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function parseIntegerVar(
  vars: EnvVars,
  name: string,
  defaultValue: number,
  errors: string[],
  { min, max }: { min: number; max: number },
): number {
  const raw = nonEmpty(vars[name]);
  if (raw === undefined) return defaultValue;

  if (!/^\d+$/.test(raw)) {
    errors.push(`${name} must be a positive integer, got "${raw}"`);
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    errors.push(`${name} must be between ${min} and ${max}, got ${parsed}`);
    return defaultValue;
  }
  return parsed;
}

function parseBoolean(
  raw: string | undefined,
  label: string,
  errors: string[],
): boolean | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  errors.push(`${label} must be "true" or "false", got "${raw}"`);
  return undefined;
}

function parseBooleanVar(
  vars: EnvVars,
  name: string,
  defaultValue: boolean,
  errors: string[],
): boolean {
  return parseBoolean(nonEmpty(vars[name]), name, errors) ?? defaultValue;
}

function parseEnumVar<T extends string>(
  vars: EnvVars,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
  errors: string[],
): T {
  const raw = nonEmpty(vars[name]);
  if (raw === undefined) return defaultValue;
  const match = allowed.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  if (match !== undefined) return match;
  errors.push(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return defaultValue;
}

interface ParsedTargetName {
  readonly name: string;
  readonly baseUrl: string;
  readonly scheme: string;
  readonly overrideSuffix: string;
}

interface ParsedTargetNames {
  readonly targets: readonly ParsedTargetName[];
  // Suffixes of every syntactically valid name, including targets dropped
  // later for a bad URL or a collision, so their overrides are reported
  // against the real cause rather than as unrelated orphans.
  readonly attemptedSuffixes: ReadonlySet<string>;
}

function parseTargetNames(vars: EnvVars, errors: string[]): ParsedTargetNames {
  const raw = nonEmpty(vars.KEA_TARGETS);
  if (raw === undefined) {
    errors.push("KEA_TARGETS is required (e.g. dhcp4-a=https://kea-a.example.com:8004)");
    return { targets: [], attemptedSuffixes: new Set() };
  }

  const parsed: ParsedTargetName[] = [];
  const attemptedSuffixes = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      errors.push("KEA_TARGETS contains an empty entry");
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      errors.push(`KEA_TARGETS entry "${trimmed}" is not in the form name=url`);
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const baseUrl = trimmed.slice(separatorIndex + 1).trim();

    if (!TARGET_NAME_PATTERN.test(name)) {
      errors.push(
        `KEA_TARGETS target name "${name}" is invalid (must start with a letter or digit, ` +
          "and contain only letters, digits, - or _)",
      );
      continue;
    }
    attemptedSuffixes.add(overrideSuffixFor(name));

    const match = BASE_URL_PATTERN.exec(baseUrl);
    if (match === null) {
      errors.push(`KEA_TARGETS target "${name}" has an invalid base URL`);
      continue;
    }
    if (match[2]?.includes("@")) {
      errors.push(
        `KEA_TARGETS target "${name}" has credentials in its URL; use KEA_USERNAME and KEA_PASSWORD_FILE instead`,
      );
      continue;
    }

    parsed.push({
      name,
      baseUrl,
      scheme: (match[1] ?? "").toLowerCase(),
      overrideSuffix: overrideSuffixFor(name),
    });
  }

  const byLowerName = new Map<string, ParsedTargetName>();
  const byOverrideSuffix = new Map<string, ParsedTargetName>();
  const deduped: ParsedTargetName[] = [];

  for (const target of parsed) {
    if (byLowerName.has(target.name.toLowerCase())) {
      errors.push(`KEA_TARGETS has duplicate target name "${target.name}"`);
      continue;
    }
    const suffixCollision = byOverrideSuffix.get(target.overrideSuffix);
    if (suffixCollision !== undefined) {
      errors.push(
        `KEA_TARGETS target names "${suffixCollision.name}" and "${target.name}" both resolve ` +
          `to override suffix "${target.overrideSuffix}"`,
      );
      continue;
    }
    byLowerName.set(target.name.toLowerCase(), target);
    byOverrideSuffix.set(target.overrideSuffix, target);
    deduped.push(target);
  }

  return { targets: deduped, attemptedSuffixes };
}

interface OrphanOverride {
  readonly key: string;
  // Set only when the suffix names a real target but the key is not in
  // canonical case, so the error can suggest the exact fix.
  readonly expectedKey: string | undefined;
}

function findOrphanOverrides(
  vars: EnvVars,
  attemptedSuffixes: ReadonlySet<string>,
): OrphanOverride[] {
  const orphans: OrphanOverride[] = [];
  for (const key of Object.keys(vars)) {
    const match = OVERRIDE_PATTERN.exec(key);
    if (match === null) continue;
    const [, base, suffix] = match;
    if (base === undefined || suffix === undefined) continue;

    const upperSuffix = suffix.toUpperCase();
    const canonicalKey = `KEA_${base.toUpperCase()}__${upperSuffix}`;
    const suffixIsKnown = attemptedSuffixes.has(upperSuffix);
    if (key !== canonicalKey || !suffixIsKnown) {
      orphans.push({ key, expectedKey: suffixIsKnown ? canonicalKey : undefined });
    }
  }
  return orphans.sort((a, b) => a.key.localeCompare(b.key));
}

interface Resolved {
  readonly value: string;
  readonly variable: string;
}

function lookup(
  vars: EnvVars,
  variable: PerTargetVariable,
  suffix: string,
  scope: "override" | "global",
): Resolved | undefined {
  const key = scope === "override" ? `KEA_${variable}__${suffix}` : `KEA_${variable}`;
  const value = nonEmpty(vars[key]);
  return value === undefined ? undefined : { value, variable: key };
}

function resolve(vars: EnvVars, variable: PerTargetVariable, suffix: string): Resolved | undefined {
  return lookup(vars, variable, suffix, "override") ?? lookup(vars, variable, suffix, "global");
}

// A per-target password setting of either form replaces both global forms,
// so one target can use an inline password while the rest share a file.
// Within one scope, setting both forms is ambiguous and rejected.
function resolvePassword(
  vars: EnvVars,
  target: ParsedTargetName,
  deps: ValidateDeps,
  errors: string[],
): { password: Secret; source: PasswordSource } | undefined {
  const { name, overrideSuffix } = target;
  for (const scope of ["override", "global"] as const) {
    const inline = lookup(vars, "PASSWORD", overrideSuffix, scope);
    const file = lookup(vars, "PASSWORD_FILE", overrideSuffix, scope);
    if (inline === undefined && file === undefined) continue;

    if (inline !== undefined && file !== undefined) {
      errors.push(
        `target "${name}": ${inline.variable} and ${file.variable} are mutually exclusive; set one`,
      );
      return undefined;
    }
    if (inline !== undefined) {
      return {
        password: new Secret(inline.value),
        source: { kind: "env", variable: inline.variable },
      };
    }
    if (file === undefined) return undefined;

    let content: string;
    try {
      content = deps.readFile(file.value);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      errors.push(
        `target "${name}": ${file.variable} could not be read (${typeof code === "string" ? code : "unreadable"})`,
      );
      return undefined;
    }
    // Strip only the line terminator an editor or `echo` adds; any other
    // whitespace is part of the password.
    const value = content.replace(/\r?\n$/, "");
    if (value === "") {
      errors.push(`target "${name}": ${file.variable} names an empty file`);
      return undefined;
    }
    return {
      password: new Secret(value),
      source: { kind: "file", variable: file.variable, path: file.value },
    };
  }

  errors.push(
    `target "${name}" has no password (set KEA_PASSWORD_FILE, KEA_PASSWORD, ` +
      `or a __${overrideSuffix} override of either)`,
  );
  return undefined;
}

function resolveTarget(
  target: ParsedTargetName,
  vars: EnvVars,
  deps: ValidateDeps,
  errors: string[],
): TargetConfig | undefined {
  const { name, baseUrl, overrideSuffix } = target;
  const errorCount = errors.length;

  const daemonRaw = resolve(vars, "DAEMON", overrideSuffix);
  let daemon: Daemon | undefined;
  if (daemonRaw === undefined) {
    errors.push(
      `target "${name}" has no daemon type (set KEA_DAEMON or KEA_DAEMON__${overrideSuffix} to one of ${DAEMONS.join(", ")})`,
    );
  } else {
    daemon = DAEMONS.find((d) => d === daemonRaw.value.toLowerCase());
    if (daemon === undefined) {
      errors.push(
        `${daemonRaw.variable} must be one of ${DAEMONS.join(", ")}, got "${daemonRaw.value}"`,
      );
    }
  }

  const username = resolve(vars, "USERNAME", overrideSuffix);
  if (username === undefined) {
    errors.push(
      `target "${name}" has no username (set KEA_USERNAME or KEA_USERNAME__${overrideSuffix})`,
    );
  } else if (username.value.includes(":")) {
    errors.push(`${username.variable} must not contain ":"`);
  }

  const password = resolvePassword(vars, target, deps, errors);

  const clientCertPath = resolve(vars, "CLIENT_CERT_PATH", overrideSuffix);
  const clientKeyPath = resolve(vars, "CLIENT_KEY_PATH", overrideSuffix);
  if ((clientCertPath === undefined) !== (clientKeyPath === undefined)) {
    errors.push(
      `target "${name}": KEA_CLIENT_CERT_PATH and KEA_CLIENT_KEY_PATH must both be set, or neither`,
    );
  }

  const skipVerify = resolve(vars, "TLS_INSECURE_SKIP_VERIFY", overrideSuffix);
  const tlsInsecureSkipVerify =
    parseBoolean(skipVerify?.value, skipVerify?.variable ?? "", errors) ?? false;

  if (errors.length > errorCount || daemon === undefined || username === undefined)
    return undefined;
  if (password === undefined) return undefined;

  return {
    name,
    baseUrl,
    daemon,
    username: username.value,
    password: password.password,
    passwordSource: password.source,
    caBundlePath: resolve(vars, "CA_BUNDLE_PATH", overrideSuffix)?.value,
    clientCertPath: clientCertPath?.value,
    clientKeyPath: clientKeyPath?.value,
    tlsInsecureSkipVerify,
  };
}

function parseMetricsTls(vars: EnvVars, errors: string[]): MetricsTlsConfig | undefined {
  const certPath = nonEmpty(vars.METRICS_TLS_CERT_PATH);
  const keyPath = nonEmpty(vars.METRICS_TLS_KEY_PATH);
  const clientCaPath = nonEmpty(vars.METRICS_TLS_CLIENT_CA_PATH);
  const minVersion = parseEnumVar<TlsMinVersion>(
    vars,
    "METRICS_TLS_MIN_VERSION",
    ["TLSv1.2", "TLSv1.3"],
    "TLSv1.2",
    errors,
  );

  if (certPath === undefined && keyPath === undefined) {
    if (clientCaPath !== undefined) {
      errors.push(
        "METRICS_TLS_CLIENT_CA_PATH requires METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH to also be set",
      );
    }
    return undefined;
  }
  if (certPath === undefined || keyPath === undefined) {
    errors.push("METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH must both be set, or neither");
    return undefined;
  }
  return { certPath, keyPath, clientCaPath, minVersion };
}

function parseMetricsBindAddress(vars: EnvVars, errors: string[]): string {
  const raw = nonEmpty(vars.METRICS_BIND_ADDRESS);
  if (raw === undefined) return "0.0.0.0";
  if (isIP(raw) === 0) {
    errors.push(`METRICS_BIND_ADDRESS must be a valid IPv4 or IPv6 address, got "${raw}"`);
    return "0.0.0.0";
  }
  return raw;
}

export function validate(vars: EnvVars, deps: ValidateDeps = defaultDeps): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { targets: parsedNames, attemptedSuffixes } = parseTargetNames(vars, errors);
  for (const orphan of findOrphanOverrides(vars, attemptedSuffixes)) {
    errors.push(
      orphan.expectedKey === undefined
        ? `${orphan.key} does not match any configured target name`
        : `${orphan.key} does not match any configured target override; did you mean "${orphan.expectedKey}"?`,
    );
  }

  const targets = parsedNames
    .map((parsedName) => resolveTarget(parsedName, vars, deps, errors))
    .filter((target): target is TargetConfig => target !== undefined);

  const plainHttp = parsedNames.filter((t) => t.scheme === "http").map((t) => t.name);
  if (plainHttp.length > 0) {
    warnings.push(
      `target(s) ${plainHttp.join(", ")} use plain http: the Kea credential crosses the network unencrypted`,
    );
  }
  const tlsSkipped = targets.filter((t) => t.tlsInsecureSkipVerify).map((t) => t.name);
  if (tlsSkipped.length > 0) {
    warnings.push(`TLS certificate verification disabled for target(s): ${tlsSkipped.join(", ")}`);
  }

  const metricsPort = parseIntegerVar(vars, "METRICS_PORT", DEFAULT_METRICS_PORT, errors, {
    min: 1,
    max: 65535,
  });
  const metricsBindAddress = parseMetricsBindAddress(vars, errors);
  const pollIntervalSeconds = parseIntegerVar(vars, "POLL_INTERVAL_SECONDS", 30, errors, {
    min: 5,
    max: 86400,
  });
  const requestTimeoutSeconds = parseIntegerVar(vars, "REQUEST_TIMEOUT_SECONDS", 15, errors, {
    min: 1,
    max: 3600,
  });
  const maxResponseBytes = parseIntegerVar(vars, "MAX_RESPONSE_BYTES", 64 * 1024 * 1024, errors, {
    min: 64 * 1024,
    max: 1024 * 1024 * 1024,
  });
  const maxSubnets = parseIntegerVar(vars, "MAX_SUBNETS", 2048, errors, { min: 1, max: 1_000_000 });

  const enablePoolStats = parseBooleanVar(vars, "ENABLE_POOL_STATS", true, errors);
  const enableSubnetLabels = parseBooleanVar(vars, "ENABLE_SUBNET_LABELS", false, errors);
  const enableD2KeyStats = parseBooleanVar(vars, "ENABLE_D2_KEY_STATS", false, errors);
  const enableDefaultMetrics = parseBooleanVar(vars, "ENABLE_DEFAULT_METRICS", true, errors);

  const logLevel = parseEnumVar<LogLevel>(
    vars,
    "LOG_LEVEL",
    ["debug", "info", "warn", "error"],
    "info",
    errors,
  );
  const logFormat = parseEnumVar<LogFormat>(vars, "LOG_FORMAT", ["json", "text"], "json", errors);
  const metricsTls = parseMetricsTls(vars, errors);

  if (errors.length > 0) throw new ConfigError(errors.join("\n"));

  const config: AppConfig = {
    targets,
    metricsPort,
    metricsBindAddress,
    pollIntervalSeconds,
    requestTimeoutSeconds,
    maxResponseBytes,
    maxSubnets,
    enablePoolStats,
    enableSubnetLabels,
    enableD2KeyStats,
    enableDefaultMetrics,
    logLevel,
    logFormat,
    metricsTls,
  };
  return { config: deepFreeze(config), warnings };
}
