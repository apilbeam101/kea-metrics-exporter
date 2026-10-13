import type { AppConfig } from "./types.ts";

// The password is resolved to its placeholder string here rather than passed
// through as the live Secret: the summary must be inert on its own, so that
// reveal() is structurally unreachable from the returned value.
export function redactSummary(config: AppConfig): Record<string, unknown> {
  return {
    targets: config.targets.map((target) => ({
      name: target.name,
      baseUrl: target.baseUrl,
      daemon: target.daemon,
      username: target.username,
      password: target.password.toString(),
      passwordSource: target.passwordSource,
      caBundlePath: target.caBundlePath,
      clientCertPath: target.clientCertPath,
      clientKeyPath: target.clientKeyPath,
      tlsInsecureSkipVerify: target.tlsInsecureSkipVerify,
    })),
    metricsPort: config.metricsPort,
    metricsBindAddress: config.metricsBindAddress,
    pollIntervalSeconds: config.pollIntervalSeconds,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
    maxResponseBytes: config.maxResponseBytes,
    maxSubnets: config.maxSubnets,
    enablePoolStats: config.enablePoolStats,
    enableSubnetLabels: config.enableSubnetLabels,
    enableD2KeyStats: config.enableD2KeyStats,
    enableDefaultMetrics: config.enableDefaultMetrics,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    metricsTls: config.metricsTls,
  };
}
