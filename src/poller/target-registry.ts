import { Registry } from "@prometheus-io/client";
import type { AppConfig, TargetConfig } from "../config/types.ts";
import { createAgent } from "../http/agent.ts";
import { KeaClient, type OnUpstreamAttempt, type UpstreamAttemptOutcome } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import { HaCollector } from "../metrics/ha-collector.ts";
import { createTargetMetricsBase, type TargetMetricsBase } from "../metrics/registry.ts";
import { STAT_TABLES } from "../metrics/stat-map.ts";
import { StatisticsCollector } from "../metrics/statistics-collector.ts";
import { StatusCollector } from "../metrics/status-collector.ts";
import {
  SubnetLabelsCollector,
  type SubnetListCommand,
} from "../metrics/subnet-labels-collector.ts";
import { RenderGate } from "./render-gate.ts";
import { SelfMetrics } from "./self-metrics.ts";
import { TargetPoller } from "./target-poller.ts";

export interface CycleResult {
  readonly up: boolean;
  // One entry per failed command this cycle, for poll_errors_total{reason}.
  readonly errors: readonly PollErrorReason[];
}

export interface TargetDeps {
  readonly clock: Clock;
  readonly warn: (target: string, message: string) => void;
  // Injectable so tests drive a target against a scripted client.
  readonly createClient?: (
    target: TargetConfig,
    onUpstreamAttempt: OnUpstreamAttempt,
  ) => Pick<KeaClient, "command"> & { close?: () => Promise<void> };
  readonly jitter?: () => number;
  readonly onCycle?: (target: string, result: CycleResult) => void;
  readonly onUpstreamAttempt?: (target: string, ...args: Parameters<OnUpstreamAttempt>) => void;
}

export const SUBNET_LIST_COMMAND: Readonly<
  Partial<Record<TargetConfig["daemon"], SubnetListCommand>>
> = {
  dhcp4: "subnet4-list",
  dhcp6: "subnet6-list",
};

export function createTargetClient(
  target: TargetConfig,
  config: AppConfig,
  clock: Clock,
  onUpstreamAttempt: OnUpstreamAttempt,
): Pick<KeaClient, "command"> & { close: () => Promise<void> } {
  const dispatcher = createAgent(target);
  const client = new KeaClient({
    baseUrl: target.baseUrl,
    username: target.username,
    password: target.password,
    dispatcher,
    clock,
    budgetMs: config.requestTimeoutSeconds * 1000,
    maxResponseBytes: config.maxResponseBytes,
    onUpstreamAttempt,
  });
  return { command: (name) => client.command(name), close: () => dispatcher.close() };
}

// One scrape target: its own Registry (D§4.4), collectors, poll loop and
// render gate. Nothing here is reachable from a render except the registry
// itself, so a scrape cannot cause an upstream call (N2).
export class Target {
  readonly name: string;
  readonly registry = new Registry();
  readonly base: TargetMetricsBase;
  readonly #client: Pick<KeaClient, "command"> & { close?: () => Promise<void> };
  readonly #status: StatusCollector;
  readonly #ha: HaCollector;
  readonly #statistics: StatisticsCollector | undefined;
  readonly #subnetLabels: SubnetLabelsCollector | undefined;
  readonly #poller: TargetPoller;
  readonly #gate = new RenderGate();
  readonly #onCycle: ((result: CycleResult) => void) | undefined;
  readonly #clock: Clock;
  readonly #self: SelfMetrics;
  // Attempts made during a cycle's fetch phase, recorded with its apply so
  // that self-telemetry, too, never changes in the middle of a render.
  #pendingAttempts: UpstreamAttemptOutcome[] = [];
  #completedCycles = 0;

  constructor(target: TargetConfig, config: AppConfig, deps: TargetDeps) {
    this.name = target.name;
    this.base = createTargetMetricsBase(this.registry);
    const warn = (message: string) => deps.warn(target.name, message);
    this.#clock = deps.clock;
    this.#self = new SelfMetrics(this.registry, deps.clock, target.tlsInsecureSkipVerify);
    const onAttempt: OnUpstreamAttempt = (outcome) => {
      this.#pendingAttempts.push(outcome);
      deps.onUpstreamAttempt?.(target.name, outcome);
    };
    this.#client =
      deps.createClient?.(target, onAttempt) ??
      createTargetClient(target, config, deps.clock, onAttempt);

    this.#status = new StatusCollector({
      client: this.#client,
      base: this.base,
      daemon: target.daemon,
      clock: deps.clock,
      warn,
    });
    this.#ha = new HaCollector({ base: this.base, warn });
    const table = STAT_TABLES[target.daemon];
    this.#statistics =
      table === undefined
        ? undefined
        : new StatisticsCollector({
            client: this.#client,
            base: this.base,
            daemon: target.daemon,
            table,
            maxSubnets: config.maxSubnets,
            enablePoolStats: config.enablePoolStats,
            enableSubnetLabels: config.enableSubnetLabels,
            enableKeyStats: config.enableD2KeyStats,
            warn,
          });
    const listCommand = SUBNET_LIST_COMMAND[target.daemon];
    this.#subnetLabels =
      config.enableSubnetLabels && listCommand !== undefined
        ? new SubnetLabelsCollector({
            client: this.#client,
            base: this.base,
            command: listCommand,
            warn,
          })
        : undefined;

    const onCycle = deps.onCycle;
    this.#onCycle = onCycle === undefined ? undefined : (result) => onCycle(target.name, result);
    this.#poller = new TargetPoller({
      clock: deps.clock,
      pollIntervalMs: config.pollIntervalSeconds * 1000,
      runCycle: () => this.runCycle().then(() => undefined),
      ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
    });
  }

  get ready(): boolean {
    return this.#completedCycles > 0;
  }

  // Every fetch completes before anything is applied, and the apply runs
  // only while no render is in flight (render-gate.ts). A failed status-get
  // skips the statistics call: the daemon is unreachable or rejecting the
  // credential, and a second call would only spend the request budget.
  async runCycle(): Promise<CycleResult> {
    const startedMs = this.#clock.elapsed();
    const status = await this.#status.fetch();
    const subnetLabels = status.status.ok ? await this.#subnetLabels?.fetch() : undefined;
    const statistics = status.status.ok ? await this.#statistics?.fetch() : undefined;

    let result: CycleResult = { up: false, errors: [] };
    await this.#gate.exclusive(() => {
      const errors: PollErrorReason[] = [];
      const statusResult = this.#status.apply(status);
      if (statusResult.kind === "success") {
        this.#ha.apply(statusResult.status.highAvailability);
        if (subnetLabels !== undefined)
          errors.push(...(this.#subnetLabels?.apply(subnetLabels) ?? []));
        if (statistics !== undefined) {
          const statsResult = this.#statistics?.apply(statistics, this.#subnetLabels?.map);
          if (statsResult?.kind === "failure") errors.push(statsResult.reason);
        }
      } else {
        errors.push(statusResult.reason);
        this.#statistics?.applySkipped();
      }
      if (status.version?.ok === false) errors.push(reasonOfError(status.version.error));
      result = { up: statusResult.kind === "success", errors };
      for (const attempt of this.#pendingAttempts) this.#self.recordAttempt(attempt);
      this.#pendingAttempts = [];
      this.#self.recordCycle(result, this.#clock.elapsed() - startedMs, this.#clock.now());
      this.#completedCycles++;
    });
    this.#onCycle?.(result);
    return result;
  }

  render(): Promise<string> {
    return this.#gate.render(() => this.registry.metrics());
  }

  start(): void {
    this.#poller.start();
  }

  waitForCycle(count: number): Promise<void> {
    return this.#poller.waitForCycle(count);
  }

  async stop(): Promise<void> {
    await this.#poller.stop();
    await this.#client.close?.();
  }
}

export class TargetRegistry {
  readonly #targets: ReadonlyMap<string, Target>;

  constructor(config: AppConfig, deps: TargetDeps) {
    this.#targets = new Map(config.targets.map((t) => [t.name, new Target(t, config, deps)]));
  }

  // Target names are matched exactly as configured, so the ?target= value
  // and the relabeled instance label are always the same string.
  get(name: string): Target | undefined {
    return this.#targets.get(name);
  }

  get targets(): readonly Target[] {
    return [...this.#targets.values()];
  }

  // /readyz: every target has completed one cycle, success or failure. A
  // permanently down target must not hold every other target's readiness
  // hostage (N3).
  get allTargetsReady(): boolean {
    return this.targets.every((t) => t.ready);
  }

  startAll(): void {
    for (const target of this.#targets.values()) target.start();
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.targets.map((t) => t.stop()));
  }
}
