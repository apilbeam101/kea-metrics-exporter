import { Counter, Gauge } from "@prometheus-io/client";
import { expectOk } from "../api/envelope.ts";
import type { StatName } from "../api/stat-name.ts";
import { templateStatName } from "../api/stat-name.ts";
import { parseStatistics, type Statistic } from "../api/statistics.ts";
import { DAEMONS, type Daemon } from "../config/types.ts";
import { EMPTY_SUBNET_MAP, type SubnetMap } from "../domain/subnet-map.ts";
import type { KeaClient } from "../http/client.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";
import type { TargetMetricsBase } from "./registry.ts";
import { DAEMON_STAT_PREFIX, ruleKey, SCOPE_LABELS, type StatTable } from "./stat-map.ts";
import { UpstreamFamily, type UpstreamSeries } from "./upstream-family.ts";

export interface StatisticsCollectorOptions {
  readonly client: Pick<KeaClient, "command">;
  readonly base: TargetMetricsBase;
  readonly daemon: Daemon;
  readonly table: StatTable;
  readonly maxSubnets: number;
  readonly enablePoolStats: boolean;
  // D§5.6: adds prefix and shared_network to every subnet and pool family.
  readonly enableSubnetLabels: boolean;
  // D§5.7: per-TSIG-key DDNS series are opt-in.
  readonly enableKeyStats: boolean;
  readonly warn: (message: string) => void;
}

export type StatisticsFetch =
  | { readonly ok: true; readonly statistics: readonly Statistic[] }
  | { readonly ok: false; readonly error: unknown };

export type StatisticsCollectResult =
  | { readonly kind: "success" }
  | { readonly kind: "mismatch"; readonly observed: readonly Daemon[] }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

function scopeLabels(parsed: StatName): Record<string, string> {
  switch (parsed.scope) {
    case "global":
      return {};
    case "subnet":
      return { subnet_id: String(parsed.subnetId) };
    case "pool":
    case "pd-pool":
      return { subnet_id: String(parsed.subnetId), pool_id: String(parsed.poolId) };
    case "key":
      return { key: parsed.key };
  }
}

const SUBNET_SCOPES: ReadonlySet<string> = new Set(["subnet", "pool", "pd-pool"]);
const SUBNET_LABELS = ["prefix", "shared_network"] as const;

function subnetIdOf(parsed: StatName | undefined): number | undefined {
  if (parsed === undefined) return undefined;
  return parsed.scope === "subnet" || parsed.scope === "pool" || parsed.scope === "pd-pool"
    ? parsed.subnetId
    : undefined;
}

// D§5.1: which daemons' statistics this response contains. Empty when the
// daemon has seen no traffic yet, which is inconclusive rather than a
// mismatch.
export function observedDaemons(names: readonly string[]): Daemon[] {
  return DAEMONS.filter((daemon) => names.some((n) => n.startsWith(DAEMON_STAT_PREFIX[daemon])));
}

// D§5.3–5.8. One statistic-get-all per cycle, routed through the daemon's
// statistic table. Every family is re-rendered from scratch each successful
// cycle, so a removed subnet or pool disappears (D§4.4); on a failed cycle
// nothing is rendered and every series keeps its last value (D§5.8).
export class StatisticsCollector {
  readonly #client: Pick<KeaClient, "command">;
  readonly #base: TargetMetricsBase;
  readonly #daemon: Daemon;
  readonly #table: StatTable;
  readonly #maxSubnets: number;
  readonly #enablePoolStats: boolean;
  readonly #enableSubnetLabels: boolean;
  readonly #enableKeyStats: boolean;
  readonly #warn: (message: string) => void;
  readonly #families: ReadonlyMap<string, UpstreamFamily>;
  readonly #specs: ReadonlyMap<string, StatTable["families"][number]>;
  readonly #mismatch: AbsentUntilSetGauge;
  readonly #truncated: Gauge;
  readonly #unknownStatistic: Counter<"name">;
  #failing = false;
  #mismatched = false;

  constructor(options: StatisticsCollectorOptions) {
    this.#client = options.client;
    this.#base = options.base;
    this.#daemon = options.daemon;
    this.#table = options.table;
    this.#maxSubnets = options.maxSubnets;
    this.#enablePoolStats = options.enablePoolStats;
    this.#enableSubnetLabels = options.enableSubnetLabels;
    this.#enableKeyStats = options.enableKeyStats;
    this.#warn = options.warn;

    const { registry } = options.base;
    this.#specs = new Map(options.table.families.map((spec) => [spec.name, spec]));
    this.#families = new Map(
      options.table.families.map((spec) => [
        spec.name,
        new UpstreamFamily(registry, spec.name, spec.help, spec.type, [
          ...SCOPE_LABELS[spec.scope],
          ...(options.enableSubnetLabels && SUBNET_SCOPES.has(spec.scope) ? SUBNET_LABELS : []),
          ...(spec.fixedLabel === undefined ? [] : [spec.fixedLabel]),
        ]),
      ]),
    );
    this.#mismatch = new AbsentUntilSetGauge(
      registry,
      "kea_daemon_mismatch",
      "1 when the configured daemon type disagrees with the statistics the target returns; absent while inconclusive",
    );
    this.#truncated = new Gauge({
      name: "kea_exporter_subnets_truncated",
      help: "Subnets dropped from rendering by MAX_SUBNETS, highest subnet IDs first",
      registers: [registry],
    });
    this.#unknownStatistic = new Counter<"name">({
      name: "kea_exporter_unknown_statistic_total",
      help: "Statistics returned by Kea that map to no metric, with subnet, pool and key indices templated out",
      labelNames: ["name"],
      registers: [registry],
    });
  }

  // Network and parsing only; nothing is written until apply().
  async fetch(): Promise<StatisticsFetch> {
    try {
      const response = await this.#client.command("statistic-get-all");
      return { ok: true, statistics: parseStatistics(expectOk("statistic-get-all", response)) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async collect(): Promise<StatisticsCollectResult> {
    return this.apply(await this.fetch());
  }

  // Used when status-get already failed this cycle: the daemon is not
  // usable, so no call is made, every series keeps its last value, and the
  // collector reads as failed rather than freezing at its last success.
  applySkipped(): void {
    this.#base.collectorSuccess.labels({ collector: "statistics" }).set(0);
  }

  apply(fetched: StatisticsFetch, subnets: SubnetMap = EMPTY_SUBNET_MAP): StatisticsCollectResult {
    if (!fetched.ok) return this.#fail(fetched.error);
    const { statistics } = fetched;

    const observed = observedDaemons(statistics.map((s) => s.name));
    if (observed.length > 0 && !observed.includes(this.#daemon)) {
      return this.#applyMismatch(observed);
    }
    if (observed.length === 0) this.#mismatch.clear();
    else this.#mismatch.set(0);
    this.#mismatched = false;

    this.#render(statistics, subnets);
    this.#base.collectorSuccess.labels({ collector: "statistics" }).set(1);
    this.#failing = false;
    return { kind: "success" };
  }

  #render(statistics: readonly Statistic[], subnets: SubnetMap): void {
    // MAX_SUBNETS keeps the lowest IDs, so the retained set is deterministic.
    const subnetIds = [
      ...new Set(statistics.map((s) => subnetIdOf(s.parsed)).filter((id) => id !== undefined)),
    ].sort((a, b) => a - b);
    const retained = new Set(subnetIds.slice(0, this.#maxSubnets));
    this.#truncated.set(subnetIds.length - retained.size);

    const series = new Map<string, UpstreamSeries[]>();
    for (const { name, parsed, value } of statistics) {
      if (parsed === undefined) {
        this.#unknownStatistic.inc({ name: templateStatName(name) });
        continue;
      }
      if ((parsed.scope === "pool" || parsed.scope === "pd-pool") && !this.#enablePoolStats)
        continue;
      if (parsed.scope === "key" && !this.#enableKeyStats) continue;
      const subnetId = subnetIdOf(parsed);
      if (subnetId !== undefined && !retained.has(subnetId)) continue;

      const rule = this.#table.rules.get(ruleKey(parsed.scope, parsed.stem));
      if (rule === undefined) {
        this.#unknownStatistic.inc({ name: templateStatName(name) });
        continue;
      }
      if (!value.ok || value.value < 0) {
        this.#base.parseErrors.inc({ group: "statistics" });
        continue;
      }

      const spec = this.#specs.get(rule.family);
      const labels = scopeLabels(parsed);
      // A subnet missing from the map renders with empty labels: expected for
      // one cycle after a reload, until the hash change refreshes the map.
      if (this.#enableSubnetLabels && subnetId !== undefined) {
        const known = subnets.get(subnetId);
        labels.prefix = known?.prefix ?? "";
        labels.shared_network = known?.sharedNetwork ?? "";
      }
      if (spec?.fixedLabel !== undefined && rule.fixedValue !== undefined) {
        labels[spec.fixedLabel] = rule.fixedValue;
      }
      const list = series.get(rule.family) ?? [];
      list.push({ labels, value: value.value });
      series.set(rule.family, list);
    }

    for (const [name, family] of this.#families) family.render(series.get(name) ?? []);
  }

  // A target mapped to the wrong daemon is a configuration error. Rendering
  // another daemon's statistics under this daemon's names would mislead, so
  // every family is emptied instead.
  #applyMismatch(observed: readonly Daemon[]): StatisticsCollectResult {
    this.#mismatch.set(1);
    for (const family of this.#families.values()) family.render([]);
    this.#base.collectorSuccess.labels({ collector: "statistics" }).set(0);
    if (!this.#mismatched) {
      this.#warn(
        `target is configured as ${this.#daemon} but returns ${observed.join(", ")} statistics; check KEA_DAEMON`,
      );
      this.#mismatched = true;
    }
    return { kind: "mismatch", observed };
  }

  #fail(error: unknown): StatisticsCollectResult {
    this.#base.collectorSuccess.labels({ collector: "statistics" }).set(0);
    const reason = reasonOfError(error);
    if (reason === "parse") this.#base.parseErrors.inc({ group: "statistics" });
    if (!this.#failing) {
      const message = error instanceof Error ? error.message : String(error);
      this.#warn(`statistics collector failed (${reason}): ${message}`);
      this.#failing = true;
    }
    return { kind: "failure", reason };
  }
}
