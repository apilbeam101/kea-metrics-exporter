import { loadBuildInfo } from "./version.ts";

const HELP_TEXT = `kea-metrics-exporter

Usage: kea-metrics-exporter [--env-file <path>] [--version] [--help]
                            [--dump-raw [--no-sanitize]]

Configuration is read from the process environment; see example.env for the
full reference. --env-file loads additional variables from a file, with the
process environment always taking precedence over it.

--dump-raw runs each read-only command once per configured target, writes
the answers as JSON to stdout and exits; logging goes to stderr. Output is
sanitised by default: addresses, hostnames, HA server names, shared-network
and key names are replaced with documentation placeholders. Subnet IDs, pool
layout and counts are kept, so review the output before sharing it.
--no-sanitize turns that off, for local debugging only.
`;

// Returns true when a flag was handled, in which case the caller exits
// without loading configuration or starting the server.
export function handleCliFlags(argv: readonly string[], write: (text: string) => void): boolean {
  if (argv.includes("--version") || argv.includes("-v")) {
    write(`${loadBuildInfo().version}\n`);
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    write(HELP_TEXT);
    return true;
  }
  return false;
}
