import type { AppConfig } from "./config/types.ts";
import type { Clock } from "./http/clock.ts";
import type { AllowedCommand } from "./http/command-allowlist.ts";
import { createTargetClient, SUBNET_LIST_COMMAND } from "./poller/target-registry.ts";
import { createSanitizer } from "./sanitize.ts";
import { loadBuildInfo } from "./version.ts";

export interface DumpRawOptions {
  readonly clock: Clock;
  readonly sanitize: boolean;
}

// A valid JSON body is spliced into the document verbatim rather than parsed
// and re-serialised, which would round values above 2^53 (D§3.2.13).
const PLACEHOLDER_PREFIX = "kea-dump-verbatim-";
const PLACEHOLDER = new RegExp(`"${PLACEHOLDER_PREFIX}(\\d+)"`, "g");

function bodyValue(body: string, verbatim: string[]): unknown {
  try {
    JSON.parse(body);
  } catch {
    return { nonJsonBody: body.slice(0, 2000) };
  }
  verbatim.push(body.trim());
  return `${PLACEHOLDER_PREFIX}${verbatim.length - 1}`;
}

// Runs each allowlisted command once per target and returns the answers as
// one JSON document. The client never puts a credential into a response and
// base URLs are not included. By default the whole document passes through
// the same sanitiser the fixture guard uses, with one mapping across every
// target, so the two sides of an HA pair stay consistent.
export async function dumpRaw(config: AppConfig, options: DumpRawOptions): Promise<string> {
  const targets: Record<string, unknown> = {};
  const verbatim: string[] = [];

  for (const target of config.targets) {
    const client = createTargetClient(target, config, options.clock, () => {});
    const commands: AllowedCommand[] = ["version-get", "status-get", "statistic-get-all"];
    const listCommand = SUBNET_LIST_COMMAND[target.daemon];
    if (listCommand !== undefined) commands.push("config-hash-get", listCommand);

    const responses: Record<string, unknown> = {};
    for (const command of commands) {
      try {
        const { statusCode, body } = await client.command(command);
        responses[command] = { httpStatus: statusCode, body: bodyValue(body, verbatim) };
      } catch (error) {
        responses[command] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    await client.close();
    targets[target.name] = { daemon: target.daemon, responses };
  }

  const json = JSON.stringify(
    {
      generator: `kea-metrics-exporter ${loadBuildInfo().version}`,
      sanitized: options.sanitize,
      targets,
    },
    null,
    2,
  );
  const document = `${json.replace(PLACEHOLDER, (_, index: string) => verbatim[Number(index)] ?? "null")}\n`;
  return options.sanitize
    ? createSanitizer({ ipv4Overflow: "redact" }).sanitize(document)
    : document;
}
