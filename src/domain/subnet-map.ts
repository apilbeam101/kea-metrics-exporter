export interface SubnetLabels {
  readonly prefix: string;
  readonly sharedNetwork: string;
}

// Subnet ID to its prefix and shared network, from subnet4-list or
// subnet6-list (D§5.6).
export type SubnetMap = ReadonlyMap<number, SubnetLabels>;

export const EMPTY_SUBNET_MAP: SubnetMap = new Map();
