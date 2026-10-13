// D§5.10: the Stork agent exporter's metric names and their equivalents
// here, taken from that exporter's source at the time of writing. Every
// Stork metric is a gauge there, including the *_total ones. Each `ours` name
// is checked against this exporter's declared metrics by
// scripts/generate-metrics-doc.ts.
export interface StorkMapping {
  readonly stork: string;
  readonly ours: string;
}

const v4Ops = [
  "discover",
  "offer",
  "request",
  "ack",
  "nak",
  "release",
  "decline",
  "inform",
  "unknown",
];
const v6Ops = [
  "solicit",
  "advertise",
  "request",
  "reply",
  "renew",
  "rebind",
  "release",
  "decline",
  "infrequest",
  "unknown",
];

export const STORK_MAPPING: readonly StorkMapping[] = [
  ...v4Ops.map((op) => ({
    stork: `kea_dhcp4_packets_received_total{operation="${op}"}`,
    ours: `kea_dhcp4_packets_received_total{type="${op}"}`,
  })),
  {
    stork: 'kea_dhcp4_packets_received_total{operation="drop"}',
    ours: "kea_dhcp4_packets_dropped_all_total",
  },
  {
    stork: 'kea_dhcp4_packets_received_total{operation="parse-failed"}',
    ours: 'kea_dhcp4_packets_dropped_total{reason="parse-failed"}',
  },
  ...["offer", "ack", "nak"].map((op) => ({
    stork: `kea_dhcp4_packets_sent_total{operation="${op}"}`,
    ours: `kea_dhcp4_packets_sent_total{type="${op}"}`,
  })),
  {
    stork: "kea_dhcp4_global4_cumulative_addresses_assigned_total",
    ours: "kea_dhcp4_assignments_total",
  },
  { stork: "kea_dhcp4_global4_addresses_declined_total", ours: "kea_dhcp4_addresses_declined" },
  {
    stork: "kea_dhcp4_global4_addresses_declined_reclaimed_total",
    ours: "kea_dhcp4_reclaimed_declined_addresses_total",
  },
  {
    stork: "kea_dhcp4_global4_addresses_reclaimed_total",
    ours: "kea_dhcp4_reclaimed_leases_total",
  },
  { stork: "kea_dhcp4_global4_allocation_fail_total", ours: "kea_dhcp4_allocation_failures_total" },
  ...["shared_network", "subnet", "no_pools", "classes"].map((cause) => ({
    stork: `kea_dhcp4_global4_allocation_fail_${cause}_total`,
    ours: `kea_dhcp4_allocation_failures_by_cause_total{cause="${cause.replace("_", "-")}"}`,
  })),
  { stork: "kea_dhcp4_global4_lease_reuses_total", ours: "kea_dhcp4_lease_reuses_total" },
  {
    stork: "kea_dhcp4_global4_reservation_conflicts_total",
    ours: "kea_dhcp4_reservation_conflicts_total",
  },
  { stork: "kea_dhcp4_addresses_total", ours: "kea_dhcp4_subnet_addresses" },
  { stork: "kea_dhcp4_addresses_assigned_total", ours: "kea_dhcp4_subnet_addresses_assigned" },
  { stork: "kea_dhcp4_addresses_declined_total", ours: "kea_dhcp4_subnet_addresses_declined" },
  {
    stork: "kea_dhcp4_addresses_declined_reclaimed_total",
    ours: "kea_dhcp4_subnet_reclaimed_declined_addresses_total",
  },
  { stork: "kea_dhcp4_addresses_reclaimed_total", ours: "kea_dhcp4_subnet_reclaimed_leases_total" },
  {
    stork: "kea_dhcp4_cumulative_addresses_assigned_total",
    ours: "kea_dhcp4_subnet_assignments_total",
  },
  { stork: "kea_dhcp4_allocation_fail_total", ours: "kea_dhcp4_subnet_allocation_failures_total" },
  { stork: "kea_dhcp4_lease_reuses_total", ours: "kea_dhcp4_subnet_lease_reuses_total" },
  {
    stork: "kea_dhcp4_reservation_conflicts_total",
    ours: "kea_dhcp4_subnet_reservation_conflicts_total",
  },
  { stork: "kea_dhcp4_pool_addresses_total", ours: "kea_dhcp4_pool_addresses" },
  { stork: "kea_dhcp4_pool_addresses_assigned_total", ours: "kea_dhcp4_pool_addresses_assigned" },
  { stork: "kea_dhcp4_pool_addresses_declined_total", ours: "kea_dhcp4_pool_addresses_declined" },
  {
    stork: "kea_dhcp4_pool_addresses_reclaimed_total",
    ours: "kea_dhcp4_pool_reclaimed_leases_total",
  },
  {
    stork: "kea_dhcp4_pool_addresses_declined_reclaimed_total",
    ours: "kea_dhcp4_pool_reclaimed_declined_addresses_total",
  },
  {
    stork: "kea_dhcp4_pool_addresses_cumulative_assigned_total",
    ours: "kea_dhcp4_pool_assignments_total",
  },
  ...v6Ops.map((op) => ({
    stork: `kea_dhcp6_packets_received_total{operation="${op}"}`,
    ours: `kea_dhcp6_packets_received_total{type="${op}"}`,
  })),
  {
    stork: 'kea_dhcp6_packets_received_total{operation="drop"}',
    ours: "kea_dhcp6_packets_dropped_all_total",
  },
  {
    stork: 'kea_dhcp6_packets_received_total{operation="parse-failed"}',
    ours: 'kea_dhcp6_packets_dropped_total{reason="parse-failed"}',
  },
  ...["advertise", "reply"].map((op) => ({
    stork: `kea_dhcp6_packets_sent_total{operation="${op}"}`,
    ours: `kea_dhcp6_packets_sent_total{type="${op}"}`,
  })),
  {
    stork: 'kea_dhcp6_packets_received_dhcp4_total{operation="query"}',
    ours: 'kea_dhcp6_packets_received_total{type="dhcpv4-query"}',
  },
  {
    stork: 'kea_dhcp6_packets_received_dhcp4_total{operation="response"}',
    ours: 'kea_dhcp6_packets_received_total{type="dhcpv4-response"}',
  },
  {
    stork: 'kea_dhcp6_packets_sent_dhcp4_total{operation="response"}',
    ours: 'kea_dhcp6_packets_sent_total{type="dhcpv4-response"}',
  },
  {
    stork: "kea_dhcp6_global6_cumulative_nas_assigned_total",
    ours: "kea_dhcp6_na_assignments_total",
  },
  {
    stork: "kea_dhcp6_global6_cumulative_pds_assigned_total",
    ours: "kea_dhcp6_pd_assignments_total",
  },
  {
    stork: "kea_dhcp6_global6_ia_na_lease_reuses_total",
    ours: 'kea_dhcp6_lease_reuses_total{ia_type="na"}',
  },
  {
    stork: "kea_dhcp6_global6_ia_pd_lease_reuses_total",
    ours: 'kea_dhcp6_lease_reuses_total{ia_type="pd"}',
  },
  { stork: "kea_dhcp6_global6_cumulutive_registered_total", ours: "kea_dhcp6_registrations_total" },
  { stork: "kea_dhcp6_na_total", ours: "kea_dhcp6_subnet_nas" },
  { stork: "kea_dhcp6_na_assigned_total", ours: "kea_dhcp6_subnet_nas_assigned" },
  { stork: "kea_dhcp6_pd_total", ours: "kea_dhcp6_subnet_pds" },
  { stork: "kea_dhcp6_pd_assigned_total", ours: "kea_dhcp6_subnet_pds_assigned" },
  {
    stork: "kea_dhcp6_cumulative_nas_assigned_total",
    ours: "kea_dhcp6_subnet_na_assignments_total",
  },
  {
    stork: "kea_dhcp6_cumulative_pds_assigned_total",
    ours: "kea_dhcp6_subnet_pd_assignments_total",
  },
  {
    stork: "kea_dhcp6_ia_na_lease_reuses_total",
    ours: 'kea_dhcp6_subnet_lease_reuses_total{ia_type="na"}',
  },
  {
    stork: "kea_dhcp6_ia_pd_lease_reuses_total",
    ours: 'kea_dhcp6_subnet_lease_reuses_total{ia_type="pd"}',
  },
  { stork: "kea_dhcp6_cumulutive_registered_total", ours: "kea_dhcp6_subnet_registrations_total" },
  { stork: "kea_dhcp6_pool_na_total", ours: "kea_dhcp6_pool_nas" },
  { stork: "kea_dhcp6_pool_na_assigned_total", ours: "kea_dhcp6_pool_nas_assigned" },
  {
    stork: "kea_dhcp6_pool_cumulative_nas_assigned_total",
    ours: "kea_dhcp6_pool_na_assignments_total",
  },
  { stork: "kea_dhcp6_pool_pd_total", ours: "kea_dhcp6_pd_pool_pds" },
  { stork: "kea_dhcp6_pool_pd_assigned_total", ours: "kea_dhcp6_pd_pool_pds_assigned" },
  {
    stork: "kea_dhcp6_pool_cumulative_pds_assigned_total",
    ours: "kea_dhcp6_pd_pool_pd_assignments_total",
  },
  {
    stork: "kea_dhcp6_pool_pd_addresses_reclaimed_total",
    ours: "kea_dhcp6_pd_pool_reclaimed_leases_total",
  },
];

// Names that exist in both exporters with a different meaning or label set.
// A query copied from a Stork dashboard keeps parsing but silently returns
// something else, so METRICS.md calls these out.
export const STORK_NAME_COLLISIONS: readonly string[] = [
  "kea_dhcp4_packets_received_total",
  "kea_dhcp4_packets_sent_total",
  "kea_dhcp6_packets_received_total",
  "kea_dhcp6_packets_sent_total",
  "kea_dhcp4_lease_reuses_total",
  "kea_dhcp4_reservation_conflicts_total",
];
