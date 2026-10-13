import { KeaHttpError } from "../http/errors.ts";

// config-hash-get answers with a digest of the running configuration and
// nothing else, which is why it, and never config-get, is the change
// detector (D§3.2.7).
export function parseConfigHash(args: unknown): string {
  const hash =
    args !== null && typeof args === "object" ? (args as { hash?: unknown }).hash : undefined;
  if (typeof hash !== "string" || hash === "") {
    throw new KeaHttpError("parse", "config-hash-get: no hash in the response");
  }
  return hash;
}
