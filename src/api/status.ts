import type { DhcpState, MultiThreading, Status } from "../domain/status.ts";
import { KeaHttpError } from "../http/errors.ts";

type Obj = Readonly<Record<string, unknown>>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(detail: string): never {
  throw new KeaHttpError("parse", `status-get: ${detail}`);
}

function requiredNumber(args: Obj, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`"${key}" is not a number`);
  return value;
}

// Absent is a valid state for every optional field; present with the wrong
// type is a parse failure rather than a silently dropped series.
function optionalNumber(args: Obj, key: string): number | undefined {
  if (!(key in args)) return undefined;
  return requiredNumber(args, key);
}

function optionalBoolean(args: Obj, key: string): boolean | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (typeof value !== "boolean") fail(`"${key}" is not a boolean`);
  return value;
}

function parseMultiThreading(args: Obj): MultiThreading | undefined {
  const enabled = optionalBoolean(args, "multi-threading-enabled");
  if (enabled === undefined) return undefined;

  let queueDepthAverages: number[] = [];
  if ("packet-queue-statistics" in args) {
    const stats = args["packet-queue-statistics"];
    if (!Array.isArray(stats) || !stats.every((v) => typeof v === "number" && Number.isFinite(v))) {
      fail('"packet-queue-statistics" is not a list of numbers');
    }
    queueDepthAverages = stats;
  }
  return {
    enabled,
    threadPoolSize: optionalNumber(args, "thread-pool-size"),
    packetQueueSize: optionalNumber(args, "packet-queue-size"),
    queueDepthAverages,
  };
}

function parseSocketStatus(args: Obj): string | undefined {
  if (!("sockets" in args)) return undefined;
  const sockets = args.sockets;
  if (!isObj(sockets) || typeof sockets.status !== "string") fail('"sockets.status" is missing');
  return sockets.status;
}

// Each disabled-by-* list counts as "held" when non-empty. Its element type
// is unconfirmed (D§9), so elements are not inspected.
function heldBy(state: Obj, key: string): boolean {
  const value = state[key];
  if (value === undefined) return false;
  if (!Array.isArray(value)) fail(`"dhcp-state.${key}" is not a list`);
  return value.length > 0;
}

function parseDhcpState(args: Obj): DhcpState | undefined {
  if (!("dhcp-state" in args)) return undefined;
  const state = args["dhcp-state"];
  if (!isObj(state)) fail('"dhcp-state" is not an object');
  return {
    globallyDisabled: optionalBoolean(state, "globally-disabled") ?? false,
    disabledBy: {
      user: optionalBoolean(state, "disabled-by-user") ?? false,
      "local-command": heldBy(state, "disabled-by-local-command"),
      "remote-command": heldBy(state, "disabled-by-remote-command"),
      "db-connection": heldBy(state, "disabled-by-db-connection"),
    },
  };
}

export function parseStatus(args: unknown): Status {
  if (!isObj(args)) fail("arguments are not an object");
  return {
    uptimeSeconds: requiredNumber(args, "uptime"),
    reloadSeconds: requiredNumber(args, "reload"),
    multiThreading: parseMultiThreading(args),
    socketStatus: parseSocketStatus(args),
    dhcpState: parseDhcpState(args),
    highAvailability: args["high-availability"],
  };
}
