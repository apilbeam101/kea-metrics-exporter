import { Gauge } from "@prometheus-io/client";
import { HA_MODES, HA_ROLES, HA_STATES, type HaRelationship, type HaRemote } from "../domain/ha.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";
import { applyStateSet, type TargetMetricsBase } from "./registry.ts";
import { classifyStateSetValue } from "./state-set.ts";

type PartnerLabels = "relationship" | "partner";

// The per-partner numeric fields of D§5.2, each read from one optional
// field of the remote block.
const PARTNER_GAUGES = [
  [
    "communicationInterrupted",
    "kea_ha_communication_interrupted",
    "1 when there has been no successful contact with the partner for longer than max-response-delay",
  ],
  [
    "inTouch",
    "kea_ha_partner_in_touch",
    "1 once this server has been in contact with the partner since it started; stays 1 while the partner is unreachable, so it is not a liveness signal",
  ],
  [
    "ageSeconds",
    "kea_ha_partner_age_seconds",
    "Seconds since this server last heard from the partner",
  ],
  [
    "clockSkewSeconds",
    "kea_ha_clock_skew_seconds",
    "Partner clock minus local clock, in seconds; signed",
  ],
  [
    "connectingClients",
    "kea_ha_connecting_clients",
    "Distinct clients seen trying to reach the partner while communication is interrupted",
  ],
  [
    "unackedClients",
    "kea_ha_unacked_clients",
    "Clients the partner has failed to answer while communication is interrupted",
  ],
  [
    "unackedClientsLeft",
    "kea_ha_unacked_clients_left",
    "Further unanswered clients before this server moves to partner-down",
  ],
  [
    "analyzedPackets",
    "kea_ha_analyzed_packets",
    "Packets examined since communication with the partner was interrupted",
  ],
] as const satisfies ReadonlyArray<readonly [keyof HaRemote, string, string]>;

type PartnerField = (typeof PARTNER_GAUGES)[number][0];

export interface HaMetrics {
  readonly relationships: AbsentUntilSetGauge;
  readonly info: Gauge<"relationship" | "server" | "partner" | "mode" | "role" | "partner_role">;
  readonly state: Gauge<"relationship" | "server" | "state">;
  readonly scopesServed: Gauge<"relationship" | "server">;
  readonly scopeServed: Gauge<"relationship" | "server" | "scope">;
  readonly partnerLastState: Gauge<PartnerLabels | "state">;
  readonly partnerLastScope: Gauge<PartnerLabels | "scope">;
  readonly partner: Readonly<Record<PartnerField, Gauge<PartnerLabels>>>;
}

export function createHaMetrics(base: TargetMetricsBase): HaMetrics {
  const registers = [base.registry];
  const partner = Object.fromEntries(
    PARTNER_GAUGES.map(([field, name, help]) => [
      field,
      new Gauge<PartnerLabels>({ name, help, labelNames: ["relationship", "partner"], registers }),
    ]),
  ) as unknown as Record<PartnerField, Gauge<PartnerLabels>>;

  return {
    relationships: new AbsentUntilSetGauge(
      base.registry,
      "kea_ha_relationships",
      "Number of HA relationships this server takes part in; absent when the HA hook is not loaded",
    ),
    info: new Gauge({
      name: "kea_ha_relationship_info",
      help: "Always 1; the relationship's mode and each side's role. partner and partner_role are empty when there is no partner block",
      labelNames: ["relationship", "server", "partner", "mode", "role", "partner_role"],
      registers,
    }),
    state: new Gauge({
      name: "kea_ha_state",
      help: "This server's HA state, as a state set over all thirteen HA states",
      labelNames: ["relationship", "server", "state"],
      registers,
    }),
    scopesServed: new Gauge({
      name: "kea_ha_scopes_served",
      help: "Number of HA scopes this server is currently serving",
      labelNames: ["relationship", "server"],
      registers,
    }),
    scopeServed: new Gauge({
      name: "kea_ha_scope_served",
      help: "1 for each HA scope this server is currently serving",
      labelNames: ["relationship", "server", "scope"],
      registers,
    }),
    partnerLastState: new Gauge({
      name: "kea_ha_partner_last_state",
      help: "The partner's HA state as last learned by this server, as a state set",
      labelNames: ["relationship", "partner", "state"],
      registers,
    }),
    partnerLastScope: new Gauge({
      name: "kea_ha_partner_last_scope",
      help: "1 for each HA scope the partner was last known to serve",
      labelNames: ["relationship", "partner", "scope"],
      registers,
    }),
    partner,
  };
}

function bounded(
  base: TargetMetricsBase,
  metric: string,
  value: string,
  allowed: readonly string[],
): string {
  if (allowed.includes(value)) return value;
  base.unknownEnum.inc({ metric, value });
  return "unknown";
}

function clear(metrics: HaMetrics): void {
  metrics.info.reset();
  metrics.state.reset();
  metrics.scopesServed.reset();
  metrics.scopeServed.reset();
  metrics.partnerLastState.reset();
  metrics.partnerLastScope.reset();
  for (const gauge of Object.values(metrics.partner)) gauge.reset();
}

// Reset and repopulate on every applied cycle, so a dissolved relationship
// or a departed partner stops being exported rather than freezing (D§4.4).
// undefined means the HA hook is not loaded: every series is absent,
// including this collector's own success series.
export function applyHa(
  metrics: HaMetrics,
  base: TargetMetricsBase,
  relationships: readonly HaRelationship[] | undefined,
): void {
  clear(metrics);
  if (relationships === undefined) {
    metrics.relationships.clear();
    base.collectorSuccess.remove({ collector: "ha" });
    return;
  }

  metrics.relationships.set(relationships.length);
  for (const { relationship, mode, local, remote } of relationships) {
    const server = local.serverName;
    metrics.info
      .labels({
        relationship,
        server,
        partner: remote?.serverName ?? "",
        mode: bounded(base, "ha_mode", mode, HA_MODES),
        role: bounded(base, "ha_role", local.role, HA_ROLES),
        partner_role: remote === undefined ? "" : bounded(base, "ha_role", remote.role, HA_ROLES),
      })
      .set(1);

    applyStateSet(
      base,
      "ha_state",
      HA_STATES,
      classifyStateSetValue(local.state, HA_STATES),
      (state, v) => metrics.state.labels({ relationship, server, state }).set(v),
    );
    metrics.scopesServed.labels({ relationship, server }).set(local.scopes.length);
    for (const scope of local.scopes)
      metrics.scopeServed.labels({ relationship, server, scope }).set(1);

    if (remote === undefined) continue;
    const partner = remote.serverName;
    if (remote.lastState !== undefined) {
      applyStateSet(
        base,
        "ha_partner_last_state",
        HA_STATES,
        classifyStateSetValue(remote.lastState, HA_STATES),
        (state, v) => metrics.partnerLastState.labels({ relationship, partner, state }).set(v),
      );
    }
    for (const scope of remote.lastScopes) {
      metrics.partnerLastScope.labels({ relationship, partner, scope }).set(1);
    }
    for (const [field] of PARTNER_GAUGES) {
      const value = remote[field];
      if (value === undefined) continue;
      metrics.partner[field]
        .labels({ relationship, partner })
        .set(typeof value === "boolean" ? Number(value) : value);
    }
  }
  base.collectorSuccess.labels({ collector: "ha" }).set(1);
}
