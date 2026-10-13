export const SOCKET_STATUSES = ["ready", "retrying", "failed"] as const;

export const DISABLED_ORIGINS = [
  "user",
  "local-command",
  "remote-command",
  "db-connection",
] as const;
export type DisabledOrigin = (typeof DISABLED_ORIGINS)[number];

export interface MultiThreading {
  readonly enabled: boolean;
  readonly threadPoolSize: number | undefined;
  readonly packetQueueSize: number | undefined;
  readonly queueDepthAverages: readonly number[];
}

export interface DhcpState {
  readonly globallyDisabled: boolean;
  readonly disabledBy: Readonly<Record<DisabledOrigin, boolean>>;
}

// D§5.1. Fields only the DHCP daemons report are undefined on a DDNS target
// (D§5.7), so a d2 target renders only what it has.
export interface Status {
  readonly uptimeSeconds: number;
  readonly reloadSeconds: number;
  readonly multiThreading: MultiThreading | undefined;
  readonly socketStatus: string | undefined;
  readonly dhcpState: DhcpState | undefined;
  // Parsed by the HA collector (D§5.2), which owns its own shape rules.
  readonly highAvailability: unknown;
}

// Upstream reports 10-, 100- and 1000-packet averages, in that order.
export const QUEUE_DEPTH_WINDOWS = ["10", "100", "1000"] as const;
