import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Registry } from "@prometheus-io/client";
import { buildGlobalRegistry } from "../src/index.ts";
import { STAT_TABLES } from "../src/metrics/stat-map.ts";
import { Target } from "../src/poller/target-registry.ts";
import { testConfig } from "../test/support/config.ts";
import { FakeClock } from "../test/support/fake-clock.ts";
import { FakeKeaClient, fixture } from "../test/support/fake-kea-client.ts";
import { STORK_MAPPING, STORK_NAME_COLLISIONS } from "./stork-mapping.ts";

export const METRICS_DOC_PATH = join(process.cwd(), "docs", "METRICS.md");

export interface Family {
  readonly name: string;
  readonly type: string;
  readonly help: string;
  readonly labels: readonly string[];
}

const SCENARIOS = [
  {
    daemon: "dhcp4",
    replies: {
      "status-get": fixture("ha/load-balancing-interrupted.json"),
      "statistic-get-all": fixture("statistics/dhcp4.json"),
      "subnet4-list": fixture("subnets/subnet4-list.json"),
    },
  },
  {
    daemon: "dhcp6",
    replies: {
      "status-get": fixture("status/dhcp4-mt-on.json"),
      "statistic-get-all": fixture("statistics/dhcp6.json"),
      "subnet6-list": fixture("subnets/subnet6-list.json"),
    },
  },
  {
    daemon: "d2",
    replies: {
      "status-get": fixture("status/d2.json"),
      "statistic-get-all": fixture("statistics/d2.json"),
    },
  },
] as const;

async function familiesOf(registry: Registry): Promise<Family[]> {
  return (await registry.getMetricsAsJSON()).map((m) => ({
    name: m.name,
    type: String(m.type),
    help: m.help,
    labels: [
      ...((registry.getSingleMetric(m.name) as { labelNames?: string[] })?.labelNames ?? []),
    ],
  }));
}

// Every declared family, found by driving one real target per daemon
// through a cycle against the test fixtures with every opt-in flag on, so
// families that only register once they have a value are present too.
export async function declaredFamilies(): Promise<{ target: Family[]; global: Family[] }> {
  const byName = new Map<string, Family>();
  for (const scenario of SCENARIOS) {
    const config = testConfig(
      { t: { url: "https://kea-a.example.com:8004", daemon: scenario.daemon } },
      { ENABLE_SUBNET_LABELS: "true", ENABLE_D2_KEY_STATS: "true" },
    );
    const [targetConfig] = config.targets;
    if (targetConfig === undefined) throw new Error("no target");
    const client = new FakeKeaClient({
      "version-get": fixture("version/version-get-extended.json"),
      "config-hash-get": fixture("config-hash/hash-a.json"),
      ...scenario.replies,
    });
    const target = new Target(targetConfig, config, {
      clock: new FakeClock(1_800_000_000_000),
      warn: () => {},
      createClient: () => client,
    });
    await target.runCycle();
    for (const family of await familiesOf(target.registry)) {
      const known = byName.get(family.name);
      byName.set(
        family.name,
        known === undefined || family.labels.length > known.labels.length ? family : known,
      );
    }
  }
  const config = testConfig(
    { t: { url: "https://kea-a.example.com:8004" } },
    { ENABLE_DEFAULT_METRICS: "false" },
  );
  const global = await familiesOf(
    buildGlobalRegistry(config, { version: "0", commit: "0", nodeVersion: "v0" }),
  );
  const sort = (a: Family, b: Family) => a.name.localeCompare(b.name);
  return { target: [...byName.values()].sort(sort), global: global.sort(sort) };
}

// The Kea statistic(s) feeding each family, from the statistic tables.
function keaSources(): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const table of Object.values(STAT_TABLES)) {
    for (const [key, rule] of table.rules) {
      const [scope = "", stem = ""] = key.split(/:(.*)/s);
      const shown =
        scope === "global"
          ? stem
          : scope === "key"
            ? `key[*].${stem}`
            : scope === "subnet"
              ? `subnet[*].${stem}`
              : `subnet[*].${scope}[*].${stem}`;
      const list = sources.get(rule.family) ?? [];
      list.push(`\`${shown}\``);
      sources.set(rule.family, list);
    }
  }
  return sources;
}

const SECTIONS: ReadonlyArray<readonly [string, (name: string) => boolean]> = [
  ["High availability", (n) => n.startsWith("kea_ha_")],
  ["DHCPv4 statistics", (n) => n.startsWith("kea_dhcp4_")],
  ["DHCPv6 statistics", (n) => n.startsWith("kea_dhcp6_")],
  ["DHCP-DDNS statistics", (n) => n.startsWith("kea_d2_")],
  ["Exporter self-observability", (n) => n.startsWith("kea_exporter_")],
  ["Per-target health", () => true],
];

const OPT_IN_LABELS = new Set(["prefix", "shared_network"]);

function labelCell(family: Family): string {
  if (family.labels.length === 0) return "—";
  return family.labels.map((l) => `\`${l}\`${OPT_IN_LABELS.has(l) ? "¹" : ""}`).join(", ");
}

function table(families: readonly Family[], sources: Map<string, string[]>): string {
  const withSources = families.some((f) => sources.has(f.name));
  const header = withSources
    ? "| Metric | Type | Labels | Kea statistic | Description |\n|---|---|---|---|---|"
    : "| Metric | Type | Labels | Description |\n|---|---|---|---|";
  const rows = families.map((f) => {
    const name = `\`${f.name}\`${f.name.startsWith("kea_d2_key_") ? "²" : ""}`;
    const cells = [name, f.type, labelCell(f)];
    if (withSources) cells.push(sources.get(f.name)?.join(", ") ?? "—");
    cells.push(f.help.replaceAll("|", "\\|"));
    return `| ${cells.join(" | ")} |`;
  });
  return [header, ...rows].join("\n");
}

export async function generateMetricsDoc(): Promise<string> {
  const { target, global } = await declaredFamilies();
  const sources = keaSources();
  const remaining = [...target];
  const parts: string[] = [
    "# Metrics",
    "",
    "Generated by `scripts/generate-metrics-doc.ts` from the exporter's live metric",
    "declarations. Do not edit by hand: `npm run generate:metrics-doc` rewrites it, and",
    "a test fails when it is out of date. For what each metric means and why it",
    "exists, see [DESIGN.md](DESIGN.md) §5.",
    "",
    "Every metric below is per target, served at `/metrics?target=<name>`, except the",
    "global ones at the end, served at bare `/metrics`.",
    "",
    "¹ Present only with `ENABLE_SUBNET_LABELS=true` (DESIGN.md §5.6).",
    "² Present only with `ENABLE_D2_KEY_STATS=true` (DESIGN.md §5.7).",
  ];

  for (const [title, matches] of SECTIONS) {
    const section = remaining.filter((f) => matches(f.name));
    for (const f of section) remaining.splice(remaining.indexOf(f), 1);
    if (section.length === 0) continue;
    parts.push("", `## ${title}`, "", table(section, sources));
  }

  parts.push(
    "",
    "## Global",
    "",
    "Served at bare `/metrics`, together with the Node.js runtime metrics when",
    "`ENABLE_DEFAULT_METRICS=true`.",
    "",
    table(global, sources),
  );

  const declared = new Set(target.map((f) => f.name));
  for (const { ours } of STORK_MAPPING) {
    const name = ours.replace(/\{.*$/, "");
    if (!declared.has(name))
      throw new Error(`stork-mapping.ts names an undeclared metric: ${name}`);
  }
  parts.push(
    "",
    "## Mapping from the Stork agent exporter",
    "",
    "Every Stork metric is a gauge, including the `*_total` ones. Here, monotonic",
    "values are counters, so `rate()` handles resets correctly. A query that read the",
    "raw value of a Stork `*_total` gauge as a current count, such as assigned",
    "addresses, moves to the unsuffixed gauge here.",
    "",
    "**Names that exist in both with a different meaning or label set.** A query",
    "copied from a Stork dashboard keeps parsing but returns something else:",
    "",
    ...STORK_NAME_COLLISIONS.map((n) => `- \`${n}\``),
    "",
    "| Stork | This exporter |",
    "|---|---|",
    ...STORK_MAPPING.map(({ stork, ours }) => `| \`${stork}\` | \`${ours}\` |`),
    "",
    "Not exported by Stork at all: the aggregate packet counters, every drop reason",
    "except `parse-failed`, the lease-query and address-registration counters, all",
    "`kea_ha_*` and per-target health metrics, and DHCP-DDNS.",
    "",
  );
  return parts.join("\n");
}

async function main(): Promise<void> {
  const generated = await generateMetricsDoc();
  if (process.argv.includes("--check")) {
    if (readFileSync(METRICS_DOC_PATH, "utf8") !== generated) {
      console.error("docs/METRICS.md is out of date; run npm run generate:metrics-doc");
      process.exit(1);
    }
    console.log("docs/METRICS.md is up to date.");
    return;
  }
  writeFileSync(METRICS_DOC_PATH, generated);
  console.log(`Wrote ${METRICS_DOC_PATH}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
