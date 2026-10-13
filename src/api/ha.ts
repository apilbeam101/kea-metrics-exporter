import { type HaLocal, type HaRelationship, type HaRemote, relationshipKey } from "../domain/ha.ts";
import { KeaHttpError } from "../http/errors.ts";

type Obj = Readonly<Record<string, unknown>>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(detail: string): never {
  throw new KeaHttpError("parse", `status-get high-availability: ${detail}`);
}

function string(obj: Obj, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") fail(`${where}.${key} is not a string`);
  return value;
}

function strings(obj: Obj, key: string, where: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    fail(`${where}.${key} is not a list of strings`);
  }
  return value;
}

function optionalNumber(obj: Obj, key: string, where: string): number | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where}.${key} is not a number`);
  return value;
}

function optionalBoolean(obj: Obj, key: string, where: string): boolean | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (typeof value !== "boolean") fail(`${where}.${key} is not a boolean`);
  return value;
}

function parseLocal(value: unknown): HaLocal {
  if (!isObj(value)) fail("local is not an object");
  return {
    serverName: string(value, "server-name", "local"),
    role: string(value, "role", "local"),
    state: string(value, "state", "local"),
    scopes: strings(value, "scopes", "local"),
  };
}

function parseRemote(value: unknown): HaRemote {
  if (!isObj(value)) fail("remote is not an object");
  const at = "remote";
  return {
    serverName: string(value, "server-name", at),
    role: string(value, "role", at),
    lastState: string(value, "last-state", at),
    lastScopes: strings(value, "last-scopes", at),
    communicationInterrupted: optionalBoolean(value, "communication-interrupted", at),
    inTouch: optionalBoolean(value, "in-touch", at),
    ageSeconds: optionalNumber(value, "age", at),
    clockSkewSeconds: optionalNumber(value, "clock-skew", at),
    connectingClients: optionalNumber(value, "connecting-clients", at),
    unackedClients: optionalNumber(value, "unacked-clients", at),
    unackedClientsLeft: optionalNumber(value, "unacked-clients-left", at),
    analyzedPackets: optionalNumber(value, "analyzed-packets", at),
  };
}

// D§3.2.15. Returns undefined when the HA hook is not loaded: that is a
// daemon with no HA to report, not a failure.
export function parseHighAvailability(value: unknown): HaRelationship[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("is not a list");

  return value.map((entry): HaRelationship => {
    if (!isObj(entry)) fail("entry is not an object");
    const mode = string(entry, "ha-mode", "entry");
    const servers = entry["ha-servers"];
    if (!isObj(servers)) fail("ha-servers is not an object");

    const local = parseLocal(servers.local);
    const remote = servers.remote === undefined ? undefined : parseRemote(servers.remote);
    return {
      relationship: relationshipKey(local.serverName, remote?.serverName),
      mode,
      local,
      remote,
    };
  });
}
