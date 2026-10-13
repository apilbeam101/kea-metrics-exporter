import { KeaHttpError } from "../http/errors.ts";
import type { Envelope } from "./envelope.ts";

const VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/;

// D§9.6: whether the version string lives in `text`, in
// `arguments.extended`, or both is unconfirmed, so both are accepted, `text`
// first. Only the leading version token is kept: the extended form carries
// build and library detail that would make an unbounded label.
export function parseVersion(envelope: Envelope & { kind: "ok" }): string {
  const fromText = VERSION.exec(envelope.text?.trim() ?? "")?.[0];
  if (fromText !== undefined) return fromText;

  const args = envelope.arguments;
  const extended =
    args !== null && typeof args === "object"
      ? (args as { extended?: unknown }).extended
      : undefined;
  const fromExtended =
    typeof extended === "string" ? VERSION.exec(extended.trim())?.[0] : undefined;
  if (fromExtended !== undefined) return fromExtended;

  throw new KeaHttpError("parse", "version-get: no version string in the response");
}

// D§3.4: the per-daemon HTTP control channel this exporter depends on is
// stable from 3.0.
export const MIN_SUPPORTED_MAJOR = 3;

export function isVersionSupported(version: string): boolean {
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) && major >= MIN_SUPPORTED_MAJOR;
}
