export type StatName =
  | { readonly scope: "global"; readonly stem: string }
  | { readonly scope: "subnet"; readonly subnetId: number; readonly stem: string }
  | {
      readonly scope: "pool" | "pd-pool";
      readonly subnetId: number;
      readonly poolId: number;
      readonly stem: string;
    }
  | { readonly scope: "key"; readonly key: string; readonly stem: string };

const POOL = /^subnet\[(\d+)\]\.(pool|pd-pool)\[(\d+)\]\.([^[\]]+)$/;
const SUBNET = /^subnet\[(\d+)\]\.([^[\]]+)$/;
const KEY = /^key\[([^[\]]+)\]\.([^[\]]+)$/;

function id(digits: string): number | undefined {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : undefined;
}

// D§3.2.10. Returns undefined for anything indexed in a form Kea does not
// produce, so a malformed name is reported rather than misfiled as global.
export function parseStatName(name: string): StatName | undefined {
  const pool = POOL.exec(name);
  if (pool !== null) {
    const [, subnet = "", kind, poolDigits = "", stem = ""] = pool;
    const subnetId = id(subnet);
    const poolId = id(poolDigits);
    if (subnetId === undefined || poolId === undefined) return undefined;
    return { scope: kind === "pool" ? "pool" : "pd-pool", subnetId, poolId, stem };
  }

  const subnet = SUBNET.exec(name);
  if (subnet !== null) {
    const [, digits = "", stem = ""] = subnet;
    const subnetId = id(digits);
    return subnetId === undefined ? undefined : { scope: "subnet", subnetId, stem };
  }

  const key = KEY.exec(name);
  if (key !== null) {
    const [, keyName = "", stem = ""] = key;
    return { scope: "key", key: keyName, stem };
  }

  if (name === "" || name.includes("[") || name.includes("]")) return undefined;
  return { scope: "global", stem: name };
}

// D§5.8: indices are replaced so an unknown-statistic label is bounded by
// Kea's statistic catalogue, not by the number of subnets, pools or keys.
export function templateStatName(name: string): string {
  return name.replace(/\[[^[\]]*\]/g, "[*]");
}
