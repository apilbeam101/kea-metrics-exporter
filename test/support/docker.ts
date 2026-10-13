import { execFileSync, spawnSync } from "node:child_process";

// Container tests run only where a Docker daemon answers; elsewhere they are
// skipped rather than failed, and CI runs them.
export function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0;
}

export function docker(args: readonly string[], timeoutMs = 600_000): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export const TEST_IMAGE = "kea-metrics-exporter:test";

export function buildTestImage(): void {
  docker(["build", "-t", TEST_IMAGE, "."]);
}
