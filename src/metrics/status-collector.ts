import { classify, expectOk, toError } from "../api/envelope.ts";
import { parseStatus } from "../api/status.ts";
import { parseVersion } from "../api/version.ts";
import type { Daemon } from "../config/types.ts";
import type { Status } from "../domain/status.ts";
import type { KeaClient } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import type { TargetMetricsBase } from "./registry.ts";
import {
  applyStatusFailure,
  applyStatusSuccess,
  applyVersion,
  createStatusMetrics,
  type StatusMetrics,
} from "./status-metrics.ts";

export interface StatusCollectorOptions {
  readonly client: Pick<KeaClient, "command">;
  readonly base: TargetMetricsBase;
  readonly daemon: Daemon;
  readonly clock: Clock;
  readonly warn: (message: string) => void;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface StatusFetch {
  readonly status: Outcome<Status>;
  readonly version: Outcome<string> | undefined;
  readonly fetchedAtSeconds: number;
}

export type StatusCollectResult =
  | { readonly kind: "success"; readonly status: Status }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

// D§5.1. kea_up derives only from the actual status-get outcome (N6). The
// version is fetched at the first success and again after every detected
// daemon restart, so an in-place upgrade is picked up without restarting
// the exporter.
//
// fetch() performs network calls only and writes nothing; apply() is
// synchronous. The poller fetches every collector first and then applies
// them all in one step, so a scrape can never see half of one cycle.
export class StatusCollector {
  readonly #client: Pick<KeaClient, "command">;
  readonly #base: TargetMetricsBase;
  readonly #metrics: StatusMetrics;
  readonly #daemon: Daemon;
  readonly #clock: Clock;
  readonly #warn: (message: string) => void;
  #lastUptime: number | undefined;
  #versionStale = true;
  #statusFailing = false;
  #versionFailing = false;

  constructor(options: StatusCollectorOptions) {
    this.#client = options.client;
    this.#base = options.base;
    this.#metrics = createStatusMetrics(options.base);
    this.#daemon = options.daemon;
    this.#clock = options.clock;
    this.#warn = options.warn;
  }

  async fetch(): Promise<StatusFetch> {
    const status = await attempt(async () =>
      parseStatus(expectOk("status-get", await this.#client.command("status-get"))),
    );
    const fetchedAtSeconds = this.#clock.now() / 1000;
    if (!status.ok) return { status, version: undefined, fetchedAtSeconds };

    // Uptime going backwards means the daemon restarted, possibly upgraded.
    const restarted =
      this.#lastUptime !== undefined && status.value.uptimeSeconds < this.#lastUptime;
    const version =
      this.#versionStale || restarted
        ? await attempt(async () => {
            const envelope = classify(await this.#client.command("version-get"));
            if (envelope.kind !== "ok") throw toError("version-get", envelope);
            return parseVersion(envelope);
          })
        : undefined;
    return { status, version, fetchedAtSeconds };
  }

  apply(fetched: StatusFetch): StatusCollectResult {
    if (!fetched.status.ok) return this.#fail(fetched.status.error);
    const status = fetched.status.value;
    this.#lastUptime = status.uptimeSeconds;

    if (fetched.version !== undefined) this.#applyVersion(fetched.version);

    try {
      applyStatusSuccess(this.#metrics, this.#base, status, fetched.fetchedAtSeconds);
    } catch (error) {
      return this.#fail(error);
    }
    this.#statusFailing = false;
    return { kind: "success", status };
  }

  async collect(): Promise<StatusCollectResult> {
    return this.apply(await this.fetch());
  }

  // A version-get failure does not affect kea_up: it marks its own collector
  // and is retried on the next cycle.
  #applyVersion(version: Outcome<string>): void {
    if (version.ok) {
      applyVersion(this.#metrics, version.value, this.#daemon);
      this.#base.collectorSuccess.labels({ collector: "version" }).set(1);
      this.#versionStale = false;
      this.#versionFailing = false;
      return;
    }
    this.#versionStale = true;
    this.#base.collectorSuccess.labels({ collector: "version" }).set(0);
    if (!this.#versionFailing) {
      this.#warn(
        `version collector failed (${reasonOfError(version.error)}): ${messageOf(version.error)}`,
      );
      this.#versionFailing = true;
    }
  }

  // Warns on the transition into failure, not on every failing cycle.
  #fail(error: unknown): StatusCollectResult {
    applyStatusFailure(this.#metrics, this.#base);
    const reason = reasonOfError(error);
    if (reason === "parse") this.#base.parseErrors.inc({ group: "status" });
    if (!this.#statusFailing) {
      this.#warn(`status collector failed (${reason}): ${messageOf(error)}`);
      this.#statusFailing = true;
    }
    return { kind: "failure", reason };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
