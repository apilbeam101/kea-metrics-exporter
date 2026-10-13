// D§3.3, from the HA hook's own state table.
export const HA_STATES = [
  "backup",
  "communication-recovery",
  "hot-standby",
  "in-maintenance",
  "load-balancing",
  "partner-down",
  "partner-in-maintenance",
  "passive-backup",
  "ready",
  "syncing",
  "terminated",
  "unavailable",
  "waiting",
] as const;
export type HaState = (typeof HA_STATES)[number];

export const HA_MODES = ["load-balancing", "hot-standby", "passive-backup"] as const;
export const HA_ROLES = ["primary", "secondary", "standby", "backup"] as const;

export interface HaLocal {
  readonly serverName: string;
  readonly role: string;
  readonly state: string;
  readonly scopes: readonly string[];
}

// Every field but the partner's name, state and scopes is optional: an absent
// field is an absent series, never zero (D§5.2).
export interface HaRemote {
  readonly serverName: string;
  readonly role: string;
  readonly lastState: string;
  readonly lastScopes: readonly string[];
  readonly communicationInterrupted: boolean | undefined;
  readonly inTouch: boolean | undefined;
  readonly ageSeconds: number | undefined;
  readonly clockSkewSeconds: number | undefined;
  readonly connectingClients: number | undefined;
  readonly unackedClients: number | undefined;
  readonly unackedClientsLeft: number | undefined;
  readonly analyzedPackets: number | undefined;
}

export interface HaRelationship {
  readonly relationship: string;
  readonly mode: string;
  readonly local: HaLocal;
  readonly remote: HaRemote | undefined;
}

// D§5.2: both servers of one relationship must report the same key, so it is
// built from the two names sorted, not from "local" and "remote", which swap
// between the two sides. With no partner block it is the local name alone.
export function relationshipKey(localName: string, remoteName: string | undefined): string {
  return remoteName === undefined ? localName : [localName, remoteName].sort().join("+");
}
