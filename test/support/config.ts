import type { AppConfig } from "../../src/config/types.ts";
import { validate } from "../../src/config/validate.ts";

// A validated configuration for tests, with every target pointed at the
// given base URLs and a fixed test credential.
export function testConfig(
  targets: Record<string, { url: string; daemon?: string }>,
  extra: Record<string, string> = {},
): AppConfig {
  const vars: Record<string, string> = {
    KEA_TARGETS: Object.entries(targets)
      .map(([name, t]) => `${name}=${t.url}`)
      .join(","),
    KEA_DAEMON: "dhcp4",
    KEA_USERNAME: "metrics",
    KEA_PASSWORD: "test-password",
    POLL_INTERVAL_SECONDS: "5",
    REQUEST_TIMEOUT_SECONDS: "2",
    ...extra,
  };
  for (const [name, t] of Object.entries(targets)) {
    if (t.daemon !== undefined)
      vars[`KEA_DAEMON__${name.toUpperCase().replace(/-/g, "_")}`] = t.daemon;
  }
  return validate(vars).config;
}
