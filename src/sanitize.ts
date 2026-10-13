import { isIPv4, isIPv6 } from "node:net";

export type LeakKind = "ip" | "domain" | "token" | "mac" | "credential" | "name";

export interface Leak {
  kind: LeakKind;
  value: string;
}

// Only addresses that describe no real network are safe: the RFC 5737
// documentation ranges, loopback, link-local and the unspecified/broadcast
// addresses. RFC 1918 and CGNAT space are deliberately not safe — in a DHCP
// fixture the private address plan is exactly the deployment detail that
// must not be published.
function isSafeIpv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  if (address === "0.0.0.0" || address === "255.255.255.255") return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

// Callers only pass strings node:net has already accepted as IPv6.
function expandIpv6(address: string): number[] {
  let text = address.toLowerCase();
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded?.[1] !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = embedded[1].split(".").map(Number);
    text = `${text.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [
    ...headGroups,
    ...Array<string>(tail === undefined ? 0 : missing).fill("0"),
    ...tailGroups,
  ];
  return groups.map((group) => Number.parseInt(group, 16));
}

function compressIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < hextets.length; ) {
    if (hextets[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < hextets.length && hextets[j] === 0) j += 1;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = hextets.map((h) => h.toString(16));
  if (bestStart === -1) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

// Unique-local (fc00::/7) space is not safe for the same reason RFC 1918 is
// not: a ULA prefix is specific to one deployment.
function isSafeIpv6(address: string): boolean {
  const hextets = expandIpv6(address);
  const [first = 0, second = 0] = hextets;
  if (hextets.every((h) => h === 0)) return true;
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  return false;
}

// RFC 7042 reserves 00-00-5E-00-53-00 through -FF for documentation.
function isSafeMac(mac: string): boolean {
  return /^00[:-]00[:-]5e[:-]00[:-]53[:-][0-9a-f]{2}$/i.test(mac);
}

const SAFE_DOMAIN_SUFFIXES = ["example.com", "example.net", "example.org"];

function isSafeDomain(domain: string): boolean {
  return SAFE_DOMAIN_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
}

const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// The maximal run of hex and colon characters, validated by node:net rather
// than by a hand-written zero-compression grammar. This also rejects
// HH:MM:SS timestamps, which Kea puts in every statistic sample.
const IPV6_PATTERN = /(?<![0-9a-fA-F:])[0-9a-fA-F:]{2,}(?![0-9a-fA-F:])/g;

const MAC_PATTERN =
  /(?<![0-9a-fA-F:-])[0-9a-fA-F]{2}([:-])(?:[0-9a-fA-F]{2}\1){4}[0-9a-fA-F]{2}(?![0-9a-fA-F:-])/g;

// Lowercase-only: real hostnames are conventionally lowercase, and Kea's own
// statistic names ("subnet[1].pool[0].assigned-addresses") never form a
// dotted run of label characters, so they are not mistaken for domains.
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/g;

// No Kea response this project reads has a legitimate 32+ character run of
// base64 or hex. Config hashes do, which is why fixtures carry placeholder
// hash strings instead.
const TOKEN_PATTERN = /\b[A-Za-z0-9+/]{32,}={0,2}/g;

const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{4,}={0,2}/g;

const SECRET_KEY = /pass(word|wd)?|secret|token/i;
const SECRET_VALUE_PATTERN =
  /("[^"]*(?:pass(?:word|wd)?|secret|token)[^"]*"\s*:\s*)"((?:[^"\\]|\\.)*)"/gi;

const SERVER_NAME_KEYS = new Set(["server-name", "this-server-name"]);
const SCOPE_KEYS = new Set(["scopes", "last-scopes"]);
const SHARED_NETWORK_KEY = "shared-network-name";
const KEY_STAT_PATTERN = /^key\[(.+?)\]\./;

const PLACEHOLDER_SERVER = /^server\d+$/;
const PLACEHOLDER_NETWORK = /^network\d+$/;
const PLACEHOLDER_KEY = /^key\d+$/;

interface StructuralNames {
  servers: string[];
  networks: string[];
  keys: string[];
}

function collectStructuralNames(value: unknown, names: StructuralNames): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuralNames(item, names);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const keyName = KEY_STAT_PATTERN.exec(key)?.[1];
    if (keyName !== undefined) names.keys.push(keyName);

    if (SERVER_NAME_KEYS.has(key) && typeof child === "string") names.servers.push(child);
    else if (SCOPE_KEYS.has(key) && Array.isArray(child)) {
      for (const scope of child) if (typeof scope === "string") names.servers.push(scope);
    } else if (key === SHARED_NETWORK_KEY && typeof child === "string" && child !== "") {
      names.networks.push(child);
    }
    collectStructuralNames(child, names);
  }
}

function collectSecretValues(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, found);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof child === "string" && child !== "" && child !== "REDACTED") {
      found.push(`${key}: ${child}`);
    }
    collectSecretValues(child, found);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function findLeaks(text: string): Leak[] {
  const leaks: Leak[] = [];

  for (const match of text.matchAll(IPV4_PATTERN)) {
    const value = match[0];
    if (isIPv4(value) && !isSafeIpv4(value)) leaks.push({ kind: "ip", value });
  }
  for (const match of text.matchAll(IPV6_PATTERN)) {
    const value = match[0];
    if (isIPv6(value) && !isSafeIpv6(value)) leaks.push({ kind: "ip", value });
  }
  for (const match of text.matchAll(MAC_PATTERN)) {
    if (!isSafeMac(match[0])) leaks.push({ kind: "mac", value: match[0] });
  }
  for (const match of text.matchAll(DOMAIN_PATTERN)) {
    if (!isSafeDomain(match[0])) leaks.push({ kind: "domain", value: match[0] });
  }
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    leaks.push({ kind: "token", value: match[0] });
  }
  for (const match of text.matchAll(BASIC_AUTH_PATTERN)) {
    if (match[0] !== "Basic REDACTED") leaks.push({ kind: "credential", value: match[0] });
  }

  const parsed = tryParseJson(text);
  if (parsed !== undefined) {
    const secrets: string[] = [];
    collectSecretValues(parsed, secrets);
    for (const value of secrets) leaks.push({ kind: "credential", value });

    const names: StructuralNames = { servers: [], networks: [], keys: [] };
    collectStructuralNames(parsed, names);
    for (const value of new Set(names.servers)) {
      if (!PLACEHOLDER_SERVER.test(value)) leaks.push({ kind: "name", value });
    }
    for (const value of new Set(names.networks)) {
      if (!PLACEHOLDER_NETWORK.test(value)) leaks.push({ kind: "name", value });
    }
    for (const value of new Set(names.keys)) {
      if (!PLACEHOLDER_KEY.test(value)) leaks.push({ kind: "name", value });
    }
  }

  return leaks;
}

const DOC_IPV4_NETWORKS = ["192.0.2", "198.51.100", "203.0.113"];

export interface Sanitizer {
  sanitize(text: string): string;
}

// One sanitizer carries its replacement maps across every input it is given,
// so the two captures from one HA pair agree on which server is "server1",
// and an address seen in both files maps to the same documentation address.
export interface SanitizerOptions {
  // What to do with a fourth distinct IPv4 /24: refuse the input (for
  // committed fixtures, which a person must then hand-author) or replace it
  // with a placeholder (for --dump-raw, which must always produce output).
  readonly ipv4Overflow?: "throw" | "redact";
}

export const REDACTED_IPV4 = "REDACTED-IPV4";

export function createSanitizer(options: SanitizerOptions = {}): Sanitizer {
  const overflow = options.ipv4Overflow ?? "throw";
  const servers = new Map<string, string>();
  const networks = new Map<string, string>();
  const keys = new Map<string, string>();
  const ipv4Networks = new Map<string, string>();
  const ipv6Prefixes = new Map<string, number>();
  const macs = new Map<string, string>();
  const domains = new Map<string, string>();
  const tokens = new Map<string, string>();

  function assign(map: Map<string, string>, value: string, prefix: string): string {
    let replacement = map.get(value);
    if (replacement === undefined) {
      replacement = `${prefix}${map.size + 1}`;
      map.set(value, replacement);
    }
    return replacement;
  }

  function renameStructural(text: string): string {
    const parsed = tryParseJson(text);
    if (parsed === undefined) return text;

    const names: StructuralNames = { servers: [], networks: [], keys: [] };
    collectStructuralNames(parsed, names);

    // Every rename goes through a sentinel first, so a real name that
    // happens to equal another name's placeholder ("server2") cannot be
    // renamed twice.
    const pending: Array<[string, string]> = [];
    let result = text;
    const stage = (from: string, to: string): void => {
      const sentinel = `\u0000${pending.length}\u0000`;
      result = result.split(from).join(sentinel);
      pending.push([sentinel, to]);
    };

    for (const name of new Set(names.servers)) {
      stage(JSON.stringify(name), JSON.stringify(assign(servers, name, "server")));
    }
    for (const name of new Set(names.networks)) {
      stage(JSON.stringify(name), JSON.stringify(assign(networks, name, "network")));
    }
    for (const name of new Set(names.keys)) {
      stage(`key[${name}].`, `key[${assign(keys, name, "key")}].`);
    }
    for (const [sentinel, to] of pending) result = result.split(sentinel).join(to);
    return result;
  }

  function mapIpv4(address: string): string {
    const octets = address.split(".");
    const network = octets.slice(0, 3).join(".");
    let replacement = ipv4Networks.get(network);
    if (replacement === undefined) {
      replacement = DOC_IPV4_NETWORKS[ipv4Networks.size];
      if (replacement === undefined) {
        if (overflow === "redact") return REDACTED_IPV4;
        throw new Error(
          "input spans more than three distinct IPv4 /24 networks; the documentation ranges cannot keep them distinct, so hand-author this fixture instead",
        );
      }
      ipv4Networks.set(network, replacement);
    }
    return `${replacement}.${octets[3]}`;
  }

  function mapIpv6(address: string): string {
    const hextets = expandIpv6(address);
    const prefix = hextets.slice(0, 3).join(":");
    let index = ipv6Prefixes.get(prefix);
    if (index === undefined) {
      index = ipv6Prefixes.size + 1;
      ipv6Prefixes.set(prefix, index);
    }
    return compressIpv6([0x2001, 0x0db8, index, ...hextets.slice(3)]);
  }

  return {
    sanitize(text: string): string {
      let result = renameStructural(text);

      result = result.replace(SECRET_VALUE_PATTERN, '$1"REDACTED"');
      result = result.replace(BASIC_AUTH_PATTERN, "Basic REDACTED");

      result = result.replace(IPV4_PATTERN, (match) =>
        isIPv4(match) && !isSafeIpv4(match) ? mapIpv4(match) : match,
      );
      result = result.replace(IPV6_PATTERN, (match) =>
        isIPv6(match) && !isSafeIpv6(match) ? mapIpv6(match) : match,
      );
      result = result.replace(MAC_PATTERN, (match) => {
        if (isSafeMac(match)) return match;
        let replacement = macs.get(match.toLowerCase());
        if (replacement === undefined) {
          replacement = `00:00:5e:00:53:${macs.size.toString(16).padStart(2, "0")}`;
          macs.set(match.toLowerCase(), replacement);
        }
        return replacement;
      });
      result = result.replace(DOMAIN_PATTERN, (match) =>
        isSafeDomain(match) ? match : `${assign(domains, match, "host")}.example.com`,
      );
      result = result.replace(TOKEN_PATTERN, (match) => assign(tokens, match, "REDACTED-TOKEN-"));

      return result;
    },
  };
}
