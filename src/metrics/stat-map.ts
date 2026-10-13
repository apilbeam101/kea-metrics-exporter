import type { StatName } from "../api/stat-name.ts";
import type { Daemon } from "../config/types.ts";
import type { UpstreamType } from "./upstream-family.ts";

export type StatScope = StatName["scope"];

export interface FamilySpec {
  readonly name: string;
  readonly type: UpstreamType;
  readonly help: string;
  readonly scope: StatScope;
  // The one label, beyond the scope's own, whose value comes from the
  // statistic name itself (type, reason, cause, ia_type).
  readonly fixedLabel: string | undefined;
}

export interface StatRule {
  readonly family: string;
  readonly fixedValue: string | undefined;
}

export interface StatTable {
  readonly daemon: Daemon;
  readonly families: readonly FamilySpec[];
  // Keyed by `${scope}:${stem}`, so a stem that means different things at
  // different scopes resolves independently.
  readonly rules: ReadonlyMap<string, StatRule>;
}

export const SCOPE_LABELS: Readonly<Record<StatScope, readonly string[]>> = {
  global: [],
  subnet: ["subnet_id"],
  pool: ["subnet_id", "pool_id"],
  "pd-pool": ["subnet_id", "pool_id"],
  key: ["key"],
};

export function ruleKey(scope: StatScope, stem: string): string {
  return `${scope}:${stem}`;
}

class TableBuilder {
  readonly #daemon: Daemon;
  readonly #families: FamilySpec[] = [];
  readonly #rules = new Map<string, StatRule>();

  constructor(daemon: Daemon) {
    this.#daemon = daemon;
  }

  #family(spec: FamilySpec): void {
    if (this.#families.some((f) => f.name === spec.name)) {
      throw new Error(`duplicate family ${spec.name}`);
    }
    this.#families.push(spec);
  }

  #rule(scope: StatScope, stem: string, rule: StatRule): void {
    const key = ruleKey(scope, stem);
    if (this.#rules.has(key)) throw new Error(`duplicate statistic ${key}`);
    this.#rules.set(key, rule);
  }

  // One Kea statistic per scope, one family per scope.
  simple(
    stem: string,
    type: UpstreamType,
    help: string,
    names: Partial<Record<StatScope, string>>,
  ): this {
    for (const [scope, name] of Object.entries(names) as Array<[StatScope, string]>) {
      this.#family({ name, type, help, scope, fixedLabel: undefined });
      this.#rule(scope, stem, { family: name, fixedValue: undefined });
    }
    return this;
  }

  // Several Kea statistics folded into one family under a label whose value
  // is the varying part of the statistic name, kept in Kea's own spelling.
  split(
    statFor: (value: string) => string,
    values: readonly string[],
    label: string,
    type: UpstreamType,
    help: string,
    names: Partial<Record<StatScope, string>>,
  ): this {
    for (const [scope, name] of Object.entries(names) as Array<[StatScope, string]>) {
      this.#family({ name, type, help, scope, fixedLabel: label });
      for (const value of values) {
        this.#rule(scope, statFor(value), { family: name, fixedValue: value });
      }
    }
    return this;
  }

  build(): StatTable {
    return { daemon: this.#daemon, families: this.#families, rules: this.#rules };
  }
}

const V4_RECEIVED = [
  "discover",
  "offer",
  "request",
  "ack",
  "nak",
  "release",
  "decline",
  "inform",
  "lease-query",
  "unknown",
];
const V4_SENT = [
  "offer",
  "ack",
  "nak",
  "lease-query-response-unassigned",
  "lease-query-response-unknown",
  "lease-query-response-active",
];
export const DROP_REASONS = [
  "parse-failed",
  "queue-full",
  "duplicate",
  "rfc-violation",
  "admin-filtered",
  "not-for-us",
  "processing-failed",
  "limit-exceeded",
  "service-disabled",
];
export const ALLOCATION_CAUSES = ["shared-network", "subnet", "no-pools", "classes"];

// D§5.3 and D§5.5.
export const DHCP4_TABLE: StatTable = new TableBuilder("dhcp4")
  .simple("pkt4-received", "counter", "DHCPv4 packets received, all types", {
    global: "kea_dhcp4_packets_received_all_total",
  })
  .split(
    (t) => `pkt4-${t}-received`,
    V4_RECEIVED,
    "type",
    "counter",
    "DHCPv4 packets received, by message type",
    {
      global: "kea_dhcp4_packets_received_total",
    },
  )
  .simple("pkt4-sent", "counter", "DHCPv4 packets sent, all types", {
    global: "kea_dhcp4_packets_sent_all_total",
  })
  .split(
    (t) => `pkt4-${t}-sent`,
    V4_SENT,
    "type",
    "counter",
    "DHCPv4 packets sent, by message type",
    {
      global: "kea_dhcp4_packets_sent_total",
    },
  )
  .simple("pkt4-receive-drop", "counter", "DHCPv4 packets dropped, all reasons", {
    global: "kea_dhcp4_packets_dropped_all_total",
  })
  .split(
    (r) => `pkt4-${r}`,
    DROP_REASONS,
    "reason",
    "counter",
    "DHCPv4 packets dropped, by reason",
    {
      global: "kea_dhcp4_packets_dropped_total",
    },
  )
  .simple("total-addresses", "gauge", "Addresses available for allocation", {
    subnet: "kea_dhcp4_subnet_addresses",
    pool: "kea_dhcp4_pool_addresses",
  })
  .simple("assigned-addresses", "gauge", "Addresses currently assigned", {
    global: "kea_dhcp4_addresses_assigned",
    subnet: "kea_dhcp4_subnet_addresses_assigned",
    pool: "kea_dhcp4_pool_addresses_assigned",
  })
  .simple("declined-addresses", "gauge", "Addresses currently declined", {
    global: "kea_dhcp4_addresses_declined",
    subnet: "kea_dhcp4_subnet_addresses_declined",
    pool: "kea_dhcp4_pool_addresses_declined",
  })
  .simple(
    "cumulative-assigned-addresses",
    "counter",
    "Address assignments; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp4_assignments_total",
      subnet: "kea_dhcp4_subnet_assignments_total",
      pool: "kea_dhcp4_pool_assignments_total",
    },
  )
  .simple(
    "reclaimed-leases",
    "counter",
    "Expired leases reclaimed; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp4_reclaimed_leases_total",
      subnet: "kea_dhcp4_subnet_reclaimed_leases_total",
      pool: "kea_dhcp4_pool_reclaimed_leases_total",
    },
  )
  .simple(
    "reclaimed-declined-addresses",
    "counter",
    "Declined addresses reclaimed; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp4_reclaimed_declined_addresses_total",
      subnet: "kea_dhcp4_subnet_reclaimed_declined_addresses_total",
      pool: "kea_dhcp4_pool_reclaimed_declined_addresses_total",
    },
  )
  .simple("v4-allocation-fail", "counter", "Address allocation failures, all causes", {
    global: "kea_dhcp4_allocation_failures_total",
    subnet: "kea_dhcp4_subnet_allocation_failures_total",
  })
  .split(
    (c) => `v4-allocation-fail-${c}`,
    ALLOCATION_CAUSES,
    "cause",
    "counter",
    "Address allocation failures, by cause",
    {
      global: "kea_dhcp4_allocation_failures_by_cause_total",
      subnet: "kea_dhcp4_subnet_allocation_failures_by_cause_total",
    },
  )
  .simple("v4-lease-reuses", "counter", "Leases renewed by reusing an existing lease", {
    global: "kea_dhcp4_lease_reuses_total",
    subnet: "kea_dhcp4_subnet_lease_reuses_total",
  })
  .simple(
    "v4-reservation-conflicts",
    "counter",
    "Allocations that conflicted with a host reservation",
    {
      global: "kea_dhcp4_reservation_conflicts_total",
      subnet: "kea_dhcp4_subnet_reservation_conflicts_total",
    },
  )
  .build();

const V6_RECEIVED = [
  "solicit",
  "advertise",
  "request",
  "reply",
  "renew",
  "rebind",
  "release",
  "decline",
  "infrequest",
  "lease-query",
  "dhcpv4-query",
  "dhcpv4-response",
  "addr-reg-inform",
  "addr-reg-reply",
  "unknown",
];
const V6_SENT = ["advertise", "reply", "lease-query-reply", "dhcpv4-response", "addr-reg-reply"];

// D§5.4 and D§5.5. Address statistics live under pool[], prefix-delegation
// statistics under pd-pool[]; the two scopes never share a family, so a
// prefix statistic can never land in an address-pool series.
export const DHCP6_TABLE: StatTable = new TableBuilder("dhcp6")
  .simple("pkt6-received", "counter", "DHCPv6 packets received, all types", {
    global: "kea_dhcp6_packets_received_all_total",
  })
  .split(
    (t) => `pkt6-${t}-received`,
    V6_RECEIVED,
    "type",
    "counter",
    "DHCPv6 packets received, by message type",
    {
      global: "kea_dhcp6_packets_received_total",
    },
  )
  .simple("pkt6-sent", "counter", "DHCPv6 packets sent, all types", {
    global: "kea_dhcp6_packets_sent_all_total",
  })
  .split(
    (t) => `pkt6-${t}-sent`,
    V6_SENT,
    "type",
    "counter",
    "DHCPv6 packets sent, by message type",
    {
      global: "kea_dhcp6_packets_sent_total",
    },
  )
  .simple("pkt6-receive-drop", "counter", "DHCPv6 packets dropped, all reasons", {
    global: "kea_dhcp6_packets_dropped_all_total",
  })
  .split(
    (r) => `pkt6-${r}`,
    DROP_REASONS,
    "reason",
    "counter",
    "DHCPv6 packets dropped, by reason",
    {
      global: "kea_dhcp6_packets_dropped_total",
    },
  )
  .simple(
    "total-nas",
    "gauge",
    "Non-temporary addresses available for allocation; can exceed 2^53, exported as the nearest float64",
    {
      subnet: "kea_dhcp6_subnet_nas",
      pool: "kea_dhcp6_pool_nas",
    },
  )
  .simple("assigned-nas", "gauge", "Non-temporary addresses currently assigned", {
    global: "kea_dhcp6_nas_assigned",
    subnet: "kea_dhcp6_subnet_nas_assigned",
    pool: "kea_dhcp6_pool_nas_assigned",
  })
  .simple("total-pds", "gauge", "Delegated prefixes available for allocation", {
    subnet: "kea_dhcp6_subnet_pds",
    "pd-pool": "kea_dhcp6_pd_pool_pds",
  })
  .simple("assigned-pds", "gauge", "Delegated prefixes currently assigned", {
    global: "kea_dhcp6_pds_assigned",
    subnet: "kea_dhcp6_subnet_pds_assigned",
    "pd-pool": "kea_dhcp6_pd_pool_pds_assigned",
  })
  .simple("declined-addresses", "gauge", "Addresses currently declined", {
    global: "kea_dhcp6_addresses_declined",
    subnet: "kea_dhcp6_subnet_addresses_declined",
    pool: "kea_dhcp6_pool_addresses_declined",
  })
  .simple(
    "cumulative-assigned-nas",
    "counter",
    "Non-temporary address assignments; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp6_na_assignments_total",
      subnet: "kea_dhcp6_subnet_na_assignments_total",
      pool: "kea_dhcp6_pool_na_assignments_total",
    },
  )
  .simple(
    "cumulative-assigned-pds",
    "counter",
    "Prefix delegations; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp6_pd_assignments_total",
      subnet: "kea_dhcp6_subnet_pd_assignments_total",
      "pd-pool": "kea_dhcp6_pd_pool_pd_assignments_total",
    },
  )
  .simple(
    "reclaimed-leases",
    "counter",
    "Expired leases reclaimed; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp6_reclaimed_leases_total",
      subnet: "kea_dhcp6_subnet_reclaimed_leases_total",
      pool: "kea_dhcp6_pool_reclaimed_leases_total",
      "pd-pool": "kea_dhcp6_pd_pool_reclaimed_leases_total",
    },
  )
  .simple(
    "reclaimed-declined-addresses",
    "counter",
    "Declined addresses reclaimed; per-subnet and per-pool values reset on configuration reload",
    {
      global: "kea_dhcp6_reclaimed_declined_addresses_total",
      subnet: "kea_dhcp6_subnet_reclaimed_declined_addresses_total",
      pool: "kea_dhcp6_pool_reclaimed_declined_addresses_total",
    },
  )
  .simple("v6-allocation-fail", "counter", "Lease allocation failures, all causes", {
    global: "kea_dhcp6_allocation_failures_total",
    subnet: "kea_dhcp6_subnet_allocation_failures_total",
  })
  .split(
    (c) => `v6-allocation-fail-${c}`,
    ALLOCATION_CAUSES,
    "cause",
    "counter",
    "Lease allocation failures, by cause",
    {
      global: "kea_dhcp6_allocation_failures_by_cause_total",
      subnet: "kea_dhcp6_subnet_allocation_failures_by_cause_total",
    },
  )
  .split(
    (t) => `v6-ia-${t}-lease-reuses`,
    ["na", "pd"],
    "ia_type",
    "counter",
    "Leases renewed by reusing an existing lease, by IA type",
    {
      global: "kea_dhcp6_lease_reuses_total",
      subnet: "kea_dhcp6_subnet_lease_reuses_total",
    },
  )
  .simple(
    "registered",
    "gauge",
    "Addresses currently registered by clients (address registration)",
    {
      subnet: "kea_dhcp6_subnet_registered",
    },
  )
  .simple(
    "cumulative-registered",
    "counter",
    "Address registrations; per-subnet values reset on configuration reload",
    {
      global: "kea_dhcp6_registrations_total",
      subnet: "kea_dhcp6_subnet_registrations_total",
    },
  )
  .build();

// D§5.7. The per-TSIG-key families carry one statistic each under key[<name>].
// The names are taken from the Kea documentation and await live confirmation
// (D§9).
const D2_UPDATES: ReadonlyArray<readonly [string, string, string]> = [
  ["update-sent", "updates_sent_total", "DNS updates sent"],
  ["update-signed", "updates_signed_total", "DNS updates sent TSIG-signed"],
  ["update-unsigned", "updates_unsigned_total", "DNS updates sent unsigned"],
  ["update-success", "updates_succeeded_total", "DNS updates that succeeded"],
  ["update-timeout", "updates_timed_out_total", "DNS updates that timed out"],
  ["update-error", "updates_failed_total", "DNS updates that failed"],
];

const d2 = new TableBuilder("d2")
  .simple("ncr-received", "counter", "Name change requests received from the DHCP servers", {
    global: "kea_d2_ncr_received_total",
  })
  .simple("ncr-invalid", "counter", "Name change requests rejected as invalid", {
    global: "kea_d2_ncr_invalid_total",
  })
  .simple("ncr-error", "counter", "Name change requests that failed to be received", {
    global: "kea_d2_ncr_errors_total",
  })
  .simple(
    "queue-mgr-queue-full",
    "counter",
    "Name change requests dropped because the queue was full",
    {
      global: "kea_d2_queue_full_total",
    },
  );
for (const [stem, suffix, help] of D2_UPDATES) {
  d2.simple(stem, "counter", help, {
    global: `kea_d2_${suffix}`,
    key: `kea_d2_key_${suffix}`,
  });
}
export const D2_TABLE: StatTable = d2.build();

export const STAT_TABLES: Readonly<Partial<Record<Daemon, StatTable>>> = {
  dhcp4: DHCP4_TABLE,
  dhcp6: DHCP6_TABLE,
  d2: D2_TABLE,
};

// D§5.1: the statistic-name prefix that identifies each daemon.
export const DAEMON_STAT_PREFIX: Readonly<Record<Daemon, string>> = {
  dhcp4: "pkt4-",
  dhcp6: "pkt6-",
  d2: "ncr-",
};
