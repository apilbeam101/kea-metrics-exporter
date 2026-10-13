#!/usr/bin/env node
// This gates main(), not module evaluation: ESM hoists every static import
// above it. Nothing in this codebase runs version-dependent code at import
// time, so that is sufficient.
import { checkNodeVersion } from "./node-version-check.ts";

checkNodeVersion();

import { pathToFileURL } from "node:url";
import { collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";
import { handleCliFlags } from "./cli.ts";
import { loadEnv } from "./config/load.ts";
import { redactSummary } from "./config/redact-summary.ts";
import type { AppConfig } from "./config/types.ts";
import { ConfigError, validate } from "./config/validate.ts";
import { dumpRaw } from "./dump-raw.ts";
import { systemClock } from "./http/clock.ts";
import { installShutdownHandlers } from "./lifecycle.ts";
import { createLogger } from "./log/logger.ts";
import { TargetRegistry } from "./poller/target-registry.ts";
import { createRequestHandler } from "./server/routes.ts";
import { type StartedServer, startServer } from "./server/server.ts";
import { type BuildInfo, loadBuildInfo } from "./version.ts";

// D§4.3: bare /metrics renders this registry alone and never aggregates
// targets.
export function buildGlobalRegistry(config: AppConfig, buildInfo: BuildInfo): Registry {
  const registry = new Registry();
  if (config.enableDefaultMetrics) collectDefaultMetrics({ register: registry });

  new Gauge({
    name: "kea_exporter_build_info",
    help: "Exporter build information; always 1",
    labelNames: ["version", "commit", "node_version"],
    registers: [registry],
  })
    .labels({
      version: buildInfo.version,
      commit: buildInfo.commit,
      node_version: buildInfo.nodeVersion,
    })
    .set(1);

  new Gauge({
    name: "kea_exporter_targets",
    help: "Number of configured targets",
    registers: [registry],
  }).set(config.targets.length);

  return registry;
}

// A failure building the targets after the listener is up (a CA bundle path
// that does not exist, say) must close the listener, or the open socket
// alone keeps a process with no working targets alive forever.
export async function afterListen<T>(
  started: StartedServer,
  build: () => T | Promise<T>,
): Promise<T> {
  try {
    return await build();
  } catch (error) {
    await started.close();
    throw error;
  }
}

// Startup order: Node version, configuration, logger and redacted summary,
// TLS warnings, build info, server listen, then the poller and signal
// handlers. The listener and the handlers both precede any upstream call, so
// /healthz answers at once and a SIGTERM during a slow first cycle still
// shuts down gracefully.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (handleCliFlags(argv, (text) => process.stdout.write(text))) return;

  let config: AppConfig;
  let warnings: readonly string[];
  try {
    ({ config, warnings } = validate(loadEnv(argv, process.env)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      error instanceof ConfigError ? `configuration error:\n${message}\n` : `${message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // --dump-raw reserves stdout for the dump, so every log line goes to
  // stderr, and it never starts the server or the poller.
  const dumping = argv.includes("--dump-raw");
  const logger = createLogger({
    level: config.logLevel,
    format: config.logFormat,
    allLogsToStderr: dumping,
  });
  logger.info("configuration loaded", redactSummary(config));
  for (const warning of warnings) logger.warn(warning);

  if (dumping) {
    const sanitize = !argv.includes("--no-sanitize");
    if (!sanitize) {
      logger.warn(
        "--no-sanitize: the dump contains real addresses and names; never share or commit it",
      );
    }
    process.stdout.write(await dumpRaw(config, { clock: systemClock, sanitize }));
    return;
  }

  const buildInfo = loadBuildInfo();
  logger.info("build info", { ...buildInfo });
  const globalRegistry = buildGlobalRegistry(config, buildInfo);

  let targetRegistry: TargetRegistry | undefined;
  const started = await startServer(
    config,
    createRequestHandler({ globalRegistry, getTargetRegistry: () => targetRegistry, logger }),
    logger,
  );
  logger.info(`listening on ${config.metricsBindAddress}:${config.metricsPort}`);

  targetRegistry = await afterListen(started, () => {
    const registry = new TargetRegistry(config, {
      clock: systemClock,
      warn: (target, message) => logger.warn(message, { target }),
    });
    installShutdownHandlers({ targetRegistry: registry, closeServer: started.close, logger });
    registry.startAll();
    return registry;
  });
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
