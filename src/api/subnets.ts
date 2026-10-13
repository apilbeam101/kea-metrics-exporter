import type { SubnetLabels, SubnetMap } from "../domain/subnet-map.ts";
import { KeaHttpError } from "../http/errors.ts";

function fail(command: string, detail: string): never {
  throw new KeaHttpError("parse", `${command}: ${detail}`);
}

// The arguments of a result-0 or result-3 subnet4-list / subnet6-list
// answer. Result 3 (no subnets) may carry an empty list or no arguments at
// all; both are an empty map.
export function parseSubnetList(command: string, args: unknown): SubnetMap {
  if (args === undefined) return new Map();
  if (args === null || typeof args !== "object") fail(command, "arguments are not an object");
  const subnets = (args as { subnets?: unknown }).subnets;
  if (subnets === undefined) return new Map();
  if (!Array.isArray(subnets)) fail(command, "subnets is not a list");

  const map = new Map<number, SubnetLabels>();
  for (const subnet of subnets) {
    const {
      id,
      subnet: prefix,
      "shared-network-name": sharedNetwork,
    } = (subnet ?? {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(id) || typeof prefix !== "string") {
      fail(command, "a subnet entry has no integer id or no prefix");
    }
    if (sharedNetwork !== undefined && typeof sharedNetwork !== "string") {
      fail(command, "shared-network-name is not a string");
    }
    map.set(id as number, { prefix, sharedNetwork: sharedNetwork ?? "" });
  }
  return map;
}
