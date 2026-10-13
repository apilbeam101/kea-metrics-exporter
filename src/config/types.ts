import type { Secret } from "./secret.ts";

export const DAEMONS = ["dhcp4", "dhcp6", "d2"] as const;
export type Daemon = (typeof DAEMONS)[number];

export type PasswordSource =
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "file"; readonly variable: string; readonly path: string };

export interface TargetConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly daemon: Daemon;
  readonly username: string;
  readonly password: Secret;
  readonly passwordSource: PasswordSource;
  readonly caBundlePath: string | undefined;
  readonly clientCertPath: string | undefined;
  readonly clientKeyPath: string | undefined;
  readonly tlsInsecureSkipVerify: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";
export type TlsMinVersion = "TLSv1.2" | "TLSv1.3";

export interface MetricsTlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
  readonly clientCaPath: string | undefined;
  readonly minVersion: TlsMinVersion;
}

export interface AppConfig {
  readonly targets: readonly TargetConfig[];
  readonly metricsPort: number;
  readonly metricsBindAddress: string;
  readonly pollIntervalSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly maxResponseBytes: number;
  readonly maxSubnets: number;
  readonly enablePoolStats: boolean;
  readonly enableSubnetLabels: boolean;
  readonly enableD2KeyStats: boolean;
  readonly enableDefaultMetrics: boolean;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
  readonly metricsTls: MetricsTlsConfig | undefined;
}
