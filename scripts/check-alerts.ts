import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPromtool } from "./fetch-promtool.ts";

async function main(): Promise<void> {
  const promtool = await fetchPromtool(join(process.cwd(), ".local", "bin"));
  const run = (args: readonly string[]) => execFileSync(promtool, args, { stdio: "inherit" });

  run(["check", "rules", "alerts/kea.yaml"]);
  run(["test", "rules", "alerts/kea.test.yaml"]);
  // The worked queries quoted in docs/DESIGN.md §5.2.
  run(["check", "rules", "test/promtool/design-queries.yaml"]);
  run(["test", "rules", "test/promtool/design-queries.test.yaml"]);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
