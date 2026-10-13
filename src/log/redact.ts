import { Secret } from "../config/secret.ts";

// Anchored at the end of the key, so "password" and "kea_password" are
// redacted but "passwordSource", which names only a variable and a path, is
// not.
const SENSITIVE_KEY = /(^|[-_])(authorization|password|passwd|secret|token|cookie|credentials?)$/i;
const PLACEHOLDER = "[REDACTED]";
const MAX_DEPTH = 8;

// D§6.5: applied at the logger boundary, so a field nobody thought to
// redact at its call site is still caught. Values under a sensitive key are
// replaced whatever their type; Secret instances are replaced wherever they
// appear. Cycles and excessive depth are cut rather than followed.
export function redactFields(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Secret) return PLACEHOLDER;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return "[TRUNCATED]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactFields(item, depth + 1, seen));

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? PLACEHOLDER : redactFields(child, depth + 1, seen);
  }
  return result;
}

// An error is reduced to its class, message and reason, along its cause
// chain. Properties attached to an error object are never serialised
// wholesale: that is where a request object, and its headers, would ride.
export function errorFields(error: unknown): Record<string, unknown> {
  const chain: Array<{ name: string; message: string }> = [];
  let current: unknown = error;
  while (current !== undefined && chain.length < 4) {
    if (current instanceof Error) {
      chain.push({ name: current.name, message: current.message });
      current = current.cause;
    } else {
      chain.push({ name: typeof current, message: String(current) });
      current = undefined;
    }
  }
  const reason = (error as { reason?: unknown } | null)?.reason;
  return {
    error: chain[0]?.message,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(chain.length > 1 ? { causes: chain.slice(1).map((c) => `${c.name}: ${c.message}`) } : {}),
  };
}
