import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import { createLogger } from "../../../src/log/logger.ts";

function capture(options: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: Array<{ stream: string; line: string }> = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    write: (stream, line) => lines.push({ stream, line }),
    ...options,
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("writes JSON lines with message, level and fields", () => {
    const { logger, lines } = capture();
    logger.info("hello", { target: "dhcp4-a" });
    const parsed = JSON.parse(lines[0]?.line ?? "");
    assert.equal(parsed.message, "hello");
    assert.equal(parsed.level, "info");
    assert.equal(parsed.target, "dhcp4-a");
  });

  it("sends warn and error to stderr, the rest to stdout", () => {
    const { logger, lines } = capture();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(
      lines.map((l) => l.stream),
      ["stdout", "stdout", "stderr", "stderr"],
    );
  });

  it("can send everything to stderr", () => {
    const { logger, lines } = capture({ allLogsToStderr: true });
    logger.info("i");
    assert.equal(lines[0]?.stream, "stderr");
  });

  it("drops lines below the configured level", () => {
    const { logger, lines } = capture({ level: "warn" });
    logger.info("hidden");
    logger.warn("shown");
    assert.equal(lines.length, 1);
  });

  it("redacts sensitive fields in both formats", () => {
    for (const format of ["json", "text"] as const) {
      const { logger, lines } = capture({ format });
      logger.info("x", { password: "hunter2", nested: { secret: new Secret("s3") } });
      assert.equal(lines[0]?.line.includes("hunter2"), false, format);
      assert.equal(lines[0]?.line.includes("s3"), false, format);
    }
  });
});
