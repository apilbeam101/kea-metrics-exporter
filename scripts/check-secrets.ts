import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchGitleaks } from "./fetch-gitleaks.ts";

// Scans the full commit history, which is the point of running it in CI
// rather than only checking the working tree. Findings are redacted.
async function main(): Promise<void> {
  const gitleaks = await fetchGitleaks(join(process.cwd(), ".local", "bin"));
  execFileSync(gitleaks, ["git", "--config", ".gitleaks.toml", "--redact", "--no-banner", "."], {
    stdio: "inherit",
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
