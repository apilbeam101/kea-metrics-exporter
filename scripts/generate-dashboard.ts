import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DASHBOARD_PATH = join(process.cwd(), "dashboards", "kea.json");

// D§7.1. Rows follow the vendor Kea dashboards' layout, with exporter health
// first and high availability second. Generated, never hand-edited, so the
// queries stay checkable against the declared metrics.

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Grafana datasource variable, resolved on import.
const DS = { type: "prometheus", uid: "${DS_PROMETHEUS}" };
const SEL = 'job=~"$job", instance=~"$instance"';
const HA_SEL = `${SEL}, relationship=~"$relationship"`;

interface Target {
  readonly expr: string;
  readonly legendFormat?: string;
  readonly instant?: boolean;
  readonly format?: "table" | "time_series";
}

interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Panel = Record<string, unknown> & { gridPos: GridPos };

class Layout {
  readonly panels: Panel[] = [];
  #y = 0;
  #x = 0;
  #rowHeight = 0;
  #id = 1;

  row(title: string, description?: string): void {
    this.#newLine();
    this.panels.push({
      id: this.#id++,
      type: "row",
      title,
      collapsed: false,
      ...(description === undefined ? {} : { description }),
      gridPos: { x: 0, y: this.#y, w: 24, h: 1 },
      panels: [],
    });
    this.#y += 1;
  }

  add(w: number, h: number, panel: Record<string, unknown>): void {
    if (this.#x + w > 24) this.#newLine();
    this.panels.push({
      id: this.#id++,
      datasource: DS,
      ...panel,
      gridPos: { x: this.#x, y: this.#y, w, h },
    });
    this.#x += w;
    this.#rowHeight = Math.max(this.#rowHeight, h);
  }

  #newLine(): void {
    this.#y += this.#rowHeight;
    this.#x = 0;
    this.#rowHeight = 0;
  }
}

const targets = (...list: Target[]) =>
  list.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, ...t }));

function timeseries(title: string, unit: string, description: string, ...list: Target[]) {
  return {
    type: "timeseries",
    title,
    description,
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: targets(...list),
  };
}

function stat(title: string, description: string, mappings: unknown[], ...list: Target[]) {
  return {
    type: "stat",
    title,
    description,
    fieldConfig: { defaults: { mappings, color: { mode: "thresholds" } }, overrides: [] },
    options: { colorMode: "background", reduceOptions: { calcs: ["lastNotNull"] } },
    targets: targets(...list),
  };
}

function table(title: string, description: string, ...list: Target[]) {
  return {
    type: "table",
    title,
    description,
    targets: targets(...list.map((t) => ({ instant: true, format: "table" as const, ...t }))),
  };
}

function stateTimeline(title: string, description: string, ...list: Target[]) {
  return { type: "state-timeline", title, description, targets: targets(...list) };
}

const UP_DOWN = [
  {
    type: "value",
    options: { "0": { text: "DOWN", color: "red" }, "1": { text: "UP", color: "green" } },
  },
];

function variable(name: string, query: string, label: string) {
  return {
    name,
    label,
    type: "query",
    datasource: DS,
    query: { query, refId: name },
    definition: query,
    refresh: 2,
    includeAll: true,
    multi: true,
    current: {},
    sort: 1,
  };
}

export function buildDashboard(): Record<string, unknown> {
  const l = new Layout();

  l.row(
    "Exporter health",
    "First: a dashboard that looks green while the exporter is down is the worst outcome.",
  );
  l.add(
    6,
    5,
    stat("Exporter reachable", "Prometheus's own up for each scrape target.", UP_DOWN, {
      expr: `up{${SEL}}`,
      legendFormat: "{{instance}}",
    }),
  );
  l.add(
    6,
    5,
    stat(
      "Kea daemon up",
      "kea_up: the daemon answered status-get and accepted the credential.",
      UP_DOWN,
      { expr: `kea_up{${SEL}}`, legendFormat: "{{instance}}" },
    ),
  );
  l.add(
    6,
    5,
    timeseries("Cache age", "s", "Seconds since each target's last successful poll.", {
      expr: `kea_exporter_cache_age_seconds{${SEL}}`,
      legendFormat: "{{instance}}",
    }),
  );
  l.add(
    6,
    5,
    timeseries("Poll errors", "short", "Failed commands per second, by reason.", {
      expr: `sum by (job, instance, reason) (rate(kea_exporter_poll_errors_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{reason}}",
    }),
  );
  l.add(
    24,
    6,
    table("Failing collectors", "Collectors whose last cycle failed. Empty is healthy.", {
      expr: `kea_collector_success{${SEL}} == 0`,
    }),
  );

  l.row("High availability", "Empty when no target loads the HA hook.");
  l.add(
    12,
    8,
    stateTimeline("HA state", "Each server's own HA state.", {
      expr: `max by (relationship, server, state) (kea_ha_state{${HA_SEL}}) == 1`,
      legendFormat: "{{server}}: {{state}}",
    }),
  );
  l.add(
    12,
    8,
    stateTimeline(
      "Partner state as seen by each side",
      "The partner's last state, as each server last learned it.",
      {
        expr: `max by (relationship, partner, instance, state) (kea_ha_partner_last_state{${HA_SEL}}) == 1`,
        legendFormat: "{{instance}} sees {{partner}}: {{state}}",
      },
    ),
  );
  l.add(
    6,
    6,
    timeseries(
      "Scopes served",
      "short",
      "Scopes each server is serving. A relationship where every server serves zero is down.",
      {
        expr: `max by (relationship, server) (kea_ha_scopes_served{${HA_SEL}})`,
        legendFormat: "{{server}}",
      },
    ),
  );
  l.add(
    6,
    6,
    timeseries(
      "Communication interrupted",
      "short",
      "1 while a server has lost contact with its partner.",
      {
        expr: `max by (instance, partner) (kea_ha_communication_interrupted{${HA_SEL}})`,
        legendFormat: "{{instance}} → {{partner}}",
      },
    ),
  );
  l.add(
    6,
    6,
    timeseries(
      "Unacked clients left before failover",
      "short",
      "How many more unanswered clients before partner-down.",
      {
        expr: `max by (instance, partner) (kea_ha_unacked_clients_left{${HA_SEL}})`,
        legendFormat: "{{instance}} → {{partner}}",
      },
    ),
  );
  l.add(
    6,
    6,
    timeseries(
      "Clock skew",
      "s",
      "Partner clock minus local clock. Kea terminates HA above 60 seconds.",
      {
        expr: `max by (instance, partner) (kea_ha_clock_skew_seconds{${HA_SEL}})`,
        legendFormat: "{{instance}} → {{partner}}",
      },
    ),
  );
  l.add(
    24,
    6,
    table("Relationships", "Each relationship's mode and each side's role.", {
      expr: `kea_ha_relationship_info{${HA_SEL}}`,
    }),
  );

  l.row("Instance overview");
  l.add(
    8,
    6,
    table("Versions", "Reported Kea version per daemon.", {
      expr: `kea_server_version_info{${SEL}}`,
    }),
  );
  l.add(
    8,
    6,
    timeseries("Uptime", "s", "Seconds since each daemon started.", {
      expr: `time() - kea_start_time_seconds{${SEL}}`,
      legendFormat: "{{instance}}",
    }),
  );
  l.add(
    8,
    6,
    timeseries("Since last reload", "s", "Seconds since the last configuration reload.", {
      expr: `time() - kea_config_reload_timestamp_seconds{${SEL}}`,
      legendFormat: "{{instance}}",
    }),
  );
  l.add(
    8,
    6,
    table(
      "Socket status",
      "DHCP socket status. Anything but ready means the daemon cannot serve on some interface.",
      { expr: `kea_control_socket_status{${SEL}} == 1` },
    ),
  );
  l.add(
    8,
    6,
    timeseries("Service disabled", "short", "1 while the DHCP service is globally disabled.", {
      expr: `kea_service_globally_disabled{${SEL}}`,
      legendFormat: "{{instance}}",
    }),
  );
  l.add(
    8,
    6,
    timeseries(
      "Packet queue depth",
      "short",
      "Average queue depth over the last 100 packets (multi-threaded daemons).",
      { expr: `kea_packet_queue_depth_avg{${SEL}, window="100"}`, legendFormat: "{{instance}}" },
    ),
  );

  l.row("DHCPv4 packets");
  l.add(
    12,
    8,
    timeseries("Received by type", "pps", "", {
      expr: `sum by (job, instance, type) (rate(kea_dhcp4_packets_received_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{type}}",
    }),
  );
  l.add(
    12,
    8,
    timeseries("Sent by type", "pps", "", {
      expr: `sum by (job, instance, type) (rate(kea_dhcp4_packets_sent_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{type}}",
    }),
  );

  l.row("DHCPv4 drops");
  l.add(
    12,
    8,
    timeseries(
      "Dropped by reason",
      "pps",
      "not-for-us is normal on an HA standby; admin-filtered is intentional.",
      {
        expr: `sum by (job, instance, reason) (rate(kea_dhcp4_packets_dropped_total{${SEL}}[5m]))`,
        legendFormat: "{{instance}} {{reason}}",
      },
    ),
  );
  l.add(
    12,
    8,
    timeseries(
      "Dropped share of received",
      "percentunit",
      "All drops as a share of all packets received.",
      {
        expr: `rate(kea_dhcp4_packets_dropped_all_total{${SEL}}[5m]) / rate(kea_dhcp4_packets_received_all_total{${SEL}}[5m])`,
        legendFormat: "{{instance}}",
      },
    ),
  );

  l.row("DHCPv4 subnets and pools");
  l.add(
    12,
    8,
    table("Subnet utilisation", "Assigned share of each subnet's addresses.", {
      expr: `max by (job, instance, subnet_id) (kea_dhcp4_subnet_addresses_assigned{${SEL}, subnet_id=~"$subnet_id"}) / max by (job, instance, subnet_id) (kea_dhcp4_subnet_addresses{${SEL}, subnet_id=~"$subnet_id"})`,
    }),
  );
  l.add(
    12,
    8,
    table("Pool utilisation", "Assigned share of each pool's addresses.", {
      expr: `max by (job, instance, subnet_id, pool_id) (kea_dhcp4_pool_addresses_assigned{${SEL}, subnet_id=~"$subnet_id"}) / max by (job, instance, subnet_id, pool_id) (kea_dhcp4_pool_addresses{${SEL}, subnet_id=~"$subnet_id"})`,
    }),
  );
  l.add(
    12,
    7,
    timeseries("Declined addresses", "short", "", {
      expr: `max by (job, instance, subnet_id) (kea_dhcp4_subnet_addresses_declined{${SEL}, subnet_id=~"$subnet_id"})`,
      legendFormat: "{{instance}} subnet {{subnet_id}}",
    }),
  );
  l.add(
    12,
    7,
    timeseries("Allocation failures by cause", "ops", "", {
      expr: `sum by (job, instance, cause) (rate(kea_dhcp4_allocation_failures_by_cause_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{cause}}",
    }),
  );

  const v6 = "Expected empty without a DHCPv6 target.";
  l.row("DHCPv6 packets and drops", v6);
  l.add(
    8,
    8,
    timeseries("Received by type", "pps", v6, {
      expr: `sum by (job, instance, type) (rate(kea_dhcp6_packets_received_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{type}}",
    }),
  );
  l.add(
    8,
    8,
    timeseries("Sent by type", "pps", v6, {
      expr: `sum by (job, instance, type) (rate(kea_dhcp6_packets_sent_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{type}}",
    }),
  );
  l.add(
    8,
    8,
    timeseries("Dropped by reason", "pps", v6, {
      expr: `sum by (job, instance, reason) (rate(kea_dhcp6_packets_dropped_total{${SEL}}[5m]))`,
      legendFormat: "{{instance}} {{reason}}",
    }),
  );

  l.row("DHCPv6 subnets and pools", v6);
  l.add(
    12,
    8,
    table("Address (NA) utilisation", v6, {
      expr: `max by (job, instance, subnet_id) (kea_dhcp6_subnet_nas_assigned{${SEL}, subnet_id=~"$subnet_id"}) / max by (job, instance, subnet_id) (kea_dhcp6_subnet_nas{${SEL}, subnet_id=~"$subnet_id"})`,
    }),
  );
  l.add(
    12,
    8,
    table("Prefix (PD) utilisation", v6, {
      expr: `max by (job, instance, subnet_id) (kea_dhcp6_subnet_pds_assigned{${SEL}, subnet_id=~"$subnet_id"}) / max by (job, instance, subnet_id) (kea_dhcp6_subnet_pds{${SEL}, subnet_id=~"$subnet_id"})`,
    }),
  );

  const d2 = "Expected empty without a DHCP-DDNS target.";
  l.row("DHCP-DDNS", d2);
  l.add(
    12,
    8,
    timeseries(
      "Name change requests",
      "ops",
      d2,
      {
        expr: `rate(kea_d2_ncr_received_total{${SEL}}[5m])`,
        legendFormat: "{{instance}} received",
      },
      { expr: `rate(kea_d2_ncr_invalid_total{${SEL}}[5m])`, legendFormat: "{{instance}} invalid" },
      { expr: `rate(kea_d2_ncr_errors_total{${SEL}}[5m])`, legendFormat: "{{instance}} errors" },
    ),
  );
  l.add(
    12,
    8,
    timeseries(
      "DNS update outcomes",
      "ops",
      d2,
      {
        expr: `rate(kea_d2_updates_succeeded_total{${SEL}}[5m])`,
        legendFormat: "{{instance}} succeeded",
      },
      {
        expr: `rate(kea_d2_updates_failed_total{${SEL}}[5m])`,
        legendFormat: "{{instance}} failed",
      },
      {
        expr: `rate(kea_d2_updates_timed_out_total{${SEL}}[5m])`,
        legendFormat: "{{instance}} timed out",
      },
    ),
  );

  return {
    __inputs: [
      {
        name: "DS_PROMETHEUS",
        label: "Prometheus",
        type: "datasource",
        pluginId: "prometheus",
        pluginName: "Prometheus",
      },
    ],
    __requires: [{ type: "datasource", id: "prometheus", name: "Prometheus", version: "1.0.0" }],
    title: "Kea DHCP",
    uid: "kea-metrics-exporter",
    description: "Generated by scripts/generate-dashboard.ts from kea-metrics-exporter metrics.",
    tags: ["kea", "dhcp"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    editable: true,
    refresh: "30s",
    time: { from: "now-6h", to: "now" },
    templating: {
      list: [
        {
          name: "DS_PROMETHEUS",
          label: "Data source",
          type: "datasource",
          query: "prometheus",
          current: {},
        },
        variable("job", "label_values(kea_up, job)", "Job"),
        variable("instance", 'label_values(kea_up{job=~"$job"}, instance)', "Target"),
        variable(
          "relationship",
          'label_values(kea_ha_relationship_info{job=~"$job"}, relationship)',
          "HA relationship",
        ),
        variable(
          "subnet_id",
          'label_values(kea_dhcp4_subnet_addresses{job=~"$job", instance=~"$instance"}, subnet_id)',
          "Subnet ID",
        ),
      ],
    },
    panels: l.panels,
  };
}

export function renderDashboard(): string {
  return `${JSON.stringify(buildDashboard(), null, 2)}\n`;
}

function main(): void {
  const rendered = renderDashboard();
  if (process.argv.includes("--check")) {
    if (readFileSync(DASHBOARD_PATH, "utf8") !== rendered) {
      console.error("dashboards/kea.json is out of date; run npm run generate:dashboard");
      process.exit(1);
    }
    console.log("dashboards/kea.json is up to date.");
    return;
  }
  writeFileSync(DASHBOARD_PATH, rendered);
  console.log(`Wrote ${DASHBOARD_PATH}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
