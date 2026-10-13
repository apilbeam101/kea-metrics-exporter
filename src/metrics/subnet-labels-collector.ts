import { Gauge } from "@prometheus-io/client";
import { parseConfigHash } from "../api/config-hash.ts";
import { classify, expectOk, toError } from "../api/envelope.ts";
import { parseSubnetList } from "../api/subnets.ts";
import { EMPTY_SUBNET_MAP, type SubnetMap } from "../domain/subnet-map.ts";
import type { KeaClient } from "../http/client.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import type { TargetMetricsBase } from "./registry.ts";

export type SubnetListCommand = "subnet4-list" | "subnet6-list";

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type ListResult =
  | { readonly kind: "map"; readonly map: SubnetMap }
  | { readonly kind: "unsupported" };

export interface SubnetLabelsFetch {
  readonly hash: Outcome<string>;
  readonly list: Outcome<ListResult> | undefined;
}

export interface SubnetLabelsOptions {
  readonly client: Pick<KeaClient, "command">;
  readonly base: TargetMetricsBase;
  readonly command: SubnetListCommand;
  readonly warn: (message: string) => void;
}

async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

// The hash a list was fetched against when config-hash-get itself failed.
// It matches no real hash, so the next successful hash read refetches.
const UNKNOWN_HASH = "\u0000unknown";

// D§5.6, opt-in. config-hash-get runs every cycle; the subnet list is
// fetched at the first cycle and again only when the configuration hash
// changes, so a reload that renumbers subnets relabels them on the next
// cycle. Without the subnet_cmds hook the list command answers result 2:
// that is recorded once and not retried until the configuration changes.
export class SubnetLabelsCollector {
  readonly #client: Pick<KeaClient, "command">;
  readonly #base: TargetMetricsBase;
  readonly #command: SubnetListCommand;
  readonly #warn: (message: string) => void;
  readonly #supported: Gauge<"command">;
  #map: SubnetMap = EMPTY_SUBNET_MAP;
  #listedAtHash: string | undefined;
  #warnedUnsupported = false;
  #failing = false;

  constructor(options: SubnetLabelsOptions) {
    this.#client = options.client;
    this.#base = options.base;
    this.#command = options.command;
    this.#warn = options.warn;
    this.#supported = new Gauge({
      name: "kea_command_supported",
      help: "0 when the daemon answers an optional command as unsupported, usually because its hook is not loaded",
      labelNames: ["command"],
      registers: [options.base.registry],
    });
  }

  get map(): SubnetMap {
    return this.#map;
  }

  async fetch(): Promise<SubnetLabelsFetch> {
    const hash = await attempt(async () =>
      parseConfigHash(expectOk("config-hash-get", await this.#client.command("config-hash-get"))),
    );
    const due = hash.ok ? hash.value !== this.#listedAtHash : this.#listedAtHash === undefined;
    if (!due) return { hash, list: undefined };

    const list = await attempt(async (): Promise<ListResult> => {
      const envelope = classify(await this.#client.command(this.#command));
      if (envelope.kind === "unsupported") return { kind: "unsupported" };
      if (envelope.kind === "ok" || envelope.kind === "empty") {
        return { kind: "map", map: parseSubnetList(this.#command, envelope.arguments) };
      }
      throw toError(this.#command, envelope);
    });
    return { hash, list };
  }

  // Returns the poll-error reasons of this cycle's failed calls.
  apply(fetched: SubnetLabelsFetch): PollErrorReason[] {
    const errors: PollErrorReason[] = [];
    if (!fetched.hash.ok) errors.push(reasonOfError(fetched.hash.error));

    const { list } = fetched;
    if (list !== undefined) {
      if (list.ok) {
        this.#listedAtHash = fetched.hash.ok ? fetched.hash.value : UNKNOWN_HASH;
        if (list.value.kind === "unsupported") {
          this.#map = EMPTY_SUBNET_MAP;
          this.#supported.labels({ command: this.#command }).set(0);
          if (!this.#warnedUnsupported) {
            this.#warn(
              `${this.#command} is not supported by this daemon (is the subnet_cmds hook loaded?); subnet labels stay empty`,
            );
            this.#warnedUnsupported = true;
          }
        } else {
          this.#map = list.value.map;
          this.#supported.labels({ command: this.#command }).set(1);
          this.#warnedUnsupported = false;
        }
      } else {
        // The previous map is kept, and the list is retried next cycle.
        errors.push(reasonOfError(list.error));
      }
    }

    for (const reason of errors) {
      if (reason === "parse") this.#base.parseErrors.inc({ group: "subnet_labels" });
    }
    const ok = errors.length === 0;
    this.#base.collectorSuccess.labels({ collector: "subnet_labels" }).set(ok ? 1 : 0);
    if (ok) {
      this.#failing = false;
    } else if (!this.#failing) {
      this.#warn(
        `subnet_labels collector failed (${errors.join(", ")}); keeping the previous labels`,
      );
      this.#failing = true;
    }
    return errors;
  }
}
