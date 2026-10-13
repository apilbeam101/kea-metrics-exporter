import { Gauge } from "@prometheus-io/client";
import { isVersionSupported } from "../api/version.ts";
import type { Daemon } from "../config/types.ts";
import {
  DISABLED_ORIGINS,
  QUEUE_DEPTH_WINDOWS,
  SOCKET_STATUSES,
  type Status,
} from "../domain/status.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";
import { applyStateSet, type TargetMetricsBase } from "./registry.ts";
import { classifyStateSetValue } from "./state-set.ts";

export interface StatusMetrics {
  readonly up: Gauge;
  readonly versionInfo: Gauge<"version" | "daemon">;
  readonly versionSupported: AbsentUntilSetGauge;
  readonly startTime: AbsentUntilSetGauge;
  readonly reloadTimestamp: AbsentUntilSetGauge;
  readonly globallyDisabled: AbsentUntilSetGauge;
  readonly serviceDisabled: Gauge<"origin">;
  readonly socketStatus: Gauge<"status">;
  readonly multiThreadingEnabled: AbsentUntilSetGauge;
  readonly threadPoolSize: AbsentUntilSetGauge;
  readonly packetQueueSize: AbsentUntilSetGauge;
  readonly packetQueueDepth: Gauge<"window">;
}

export function createStatusMetrics(base: TargetMetricsBase): StatusMetrics {
  const { registry } = base;
  const registers = [registry];
  return {
    up: new Gauge({
      name: "kea_up",
      help: "1 if and only if the last cycle's status-get reached the daemon, the credential was accepted, and it succeeded",
      registers,
    }),
    versionInfo: new Gauge<"version" | "daemon">({
      name: "kea_server_version_info",
      help: "Always 1; the daemon's reported Kea version",
      labelNames: ["version", "daemon"],
      registers,
    }),
    versionSupported: new AbsentUntilSetGauge(
      registry,
      "kea_server_version_supported",
      "0 if the daemon's reported version is below the minimum supported 3.0.0",
    ),
    startTime: new AbsentUntilSetGauge(
      registry,
      "kea_start_time_seconds",
      "Daemon start time, derived from poll time minus reported uptime and rounded to whole seconds",
    ),
    reloadTimestamp: new AbsentUntilSetGauge(
      registry,
      "kea_config_reload_timestamp_seconds",
      "Last configuration reload time, derived from poll time minus seconds since reload and rounded to whole seconds",
    ),
    globallyDisabled: new AbsentUntilSetGauge(
      registry,
      "kea_service_globally_disabled",
      "1 when the DHCP service is globally disabled (Kea's globally-disabled flag)",
    ),
    serviceDisabled: new Gauge<"origin">({
      name: "kea_service_disabled",
      help: "1 when this origin holds the DHCP service disabled",
      labelNames: ["origin"],
      registers,
    }),
    socketStatus: new Gauge<"status">({
      name: "kea_control_socket_status",
      help: "DHCP socket status as a state set over ready, retrying and failed",
      labelNames: ["status"],
      registers,
    }),
    multiThreadingEnabled: new AbsentUntilSetGauge(
      registry,
      "kea_multi_threading_enabled",
      "1 when the daemon runs multi-threaded",
    ),
    threadPoolSize: new AbsentUntilSetGauge(
      registry,
      "kea_thread_pool_size",
      "Packet-processing thread pool size; absent when multi-threading is off",
    ),
    packetQueueSize: new AbsentUntilSetGauge(
      registry,
      "kea_packet_queue_size",
      "Configured packet queue capacity; absent when multi-threading is off",
    ),
    packetQueueDepth: new Gauge<"window">({
      name: "kea_packet_queue_depth_avg",
      help: "Average packet queue depth over the last 10, 100 and 1000 packets",
      labelNames: ["window"],
      registers,
    }),
  };
}

export function applyVersion(metrics: StatusMetrics, version: string, daemon: Daemon): void {
  metrics.versionInfo.reset();
  metrics.versionInfo.labels({ version, daemon }).set(1);
  metrics.versionSupported.set(isVersionSupported(version) ? 1 : 0);
}

// kea_up (N6) is written first, so it lands at 0 even if anything after it
// were to throw. Every other series keeps its last value (D§5.8).
export function applyStatusFailure(metrics: StatusMetrics, base: TargetMetricsBase): void {
  metrics.up.set(0);
  base.collectorSuccess.labels({ collector: "status" }).set(0);
}

// kea_up is written last, only once everything else has been applied, so a
// throw partway through can never leave it at 1 for an unfinished cycle.
export function applyStatusSuccess(
  metrics: StatusMetrics,
  base: TargetMetricsBase,
  status: Status,
  nowSeconds: number,
): void {
  metrics.startTime.set(Math.round(nowSeconds - status.uptimeSeconds));
  metrics.reloadTimestamp.set(Math.round(nowSeconds - status.reloadSeconds));

  metrics.serviceDisabled.reset();
  if (status.dhcpState === undefined) {
    metrics.globallyDisabled.clear();
  } else {
    metrics.globallyDisabled.set(status.dhcpState.globallyDisabled ? 1 : 0);
    for (const origin of DISABLED_ORIGINS) {
      metrics.serviceDisabled.labels({ origin }).set(status.dhcpState.disabledBy[origin] ? 1 : 0);
    }
  }

  metrics.socketStatus.reset();
  if (status.socketStatus !== undefined) {
    applyStateSet(
      base,
      "control_socket_status",
      SOCKET_STATUSES,
      classifyStateSetValue(status.socketStatus, SOCKET_STATUSES),
      (value, isActual) => metrics.socketStatus.labels({ status: value }).set(isActual),
    );
  }

  const mt = status.multiThreading;
  metrics.packetQueueDepth.reset();
  if (mt === undefined) {
    metrics.multiThreadingEnabled.clear();
    metrics.threadPoolSize.clear();
    metrics.packetQueueSize.clear();
  } else {
    metrics.multiThreadingEnabled.set(mt.enabled ? 1 : 0);
    metrics.threadPoolSize.setOrClear(mt.enabled ? mt.threadPoolSize : undefined);
    metrics.packetQueueSize.setOrClear(mt.enabled ? mt.packetQueueSize : undefined);
    if (mt.enabled) {
      QUEUE_DEPTH_WINDOWS.forEach((window, index) => {
        const value = mt.queueDepthAverages[index];
        if (value !== undefined) metrics.packetQueueDepth.labels({ window }).set(value);
      });
    }
  }

  base.collectorSuccess.labels({ collector: "status" }).set(1);
  metrics.up.set(1);
}
