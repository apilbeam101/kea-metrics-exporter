// D§3.1 and D§6.3. Every command here is classified `read` in Kea's own API
// definitions. The Kea credential can run any command, so this list is the
// only thing keeping the exporter read-only: never add a `write` command,
// and never add config-get, whose response contains plaintext secrets.
export const ALLOWED_COMMANDS = [
  "version-get",
  "status-get",
  "statistic-get-all",
  "config-hash-get",
  "subnet4-list",
  "subnet6-list",
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

const allowed: ReadonlySet<string> = new Set(ALLOWED_COMMANDS);

export function assertCommandAllowed(name: string): asserts name is AllowedCommand {
  if (!allowed.has(name)) {
    throw new Error(`command "${name}" is not in the read-only allowlist`);
  }
}
