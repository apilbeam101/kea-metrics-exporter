# Design

A Prometheus exporter for [ISC Kea DHCP](https://www.isc.org/kea/).

This document describes what the exporter is, what it exposes, and why each
decision was made. It is the reference for reviewers and for anyone deciding
whether the exporter fits their deployment. For how it gets built, see
[IMPLEMENTATION.md](IMPLEMENTATION.md). A generated metric reference,
`METRICS.md`, is produced from the live metric declarations by
`scripts/generate-metrics-doc.ts` (see [IMPLEMENTATION.md](IMPLEMENTATION.md)
Phase 11), with a test asserting it stays in sync with the code.

Upstream behaviour is cited against the Kea 3.2 Administrator Reference Manual
(`https://kea.readthedocs.io/en/kea-3.2.0/arm/`, abbreviated **ARM**) and the
Kea source at the `Kea-3.2.0` tag (abbreviated **KEA**). Anything not yet
confirmed against a running server is listed in [§9](#9-open-questions).

---

## 1. Context

Kea keeps a rich set of internal statistics and exposes them, together with
daemon and high-availability status, over a JSON command API. It has no native
Prometheus endpoint.

ISC's own Stork agent includes a Prometheus exporter. It covers lease, pool and
packet counts well, but leaves three gaps that matter in production:

- **No high-availability state.** It never calls `status-get`, so HA role,
  state, partner reachability and failover progress are not exported at all.
- **Discarded counters.** It drops the aggregate `pkt4-received`/`pkt4-sent`
  totals and most of the per-reason drop counters (`pkt4-queue-full`,
  `-rfc-violation`, `-admin-filtered`, `-limit-exceeded`, `-duplicate`,
  `-service-disabled`, `-not-for-us`, `-processing-failed`), along with the
  lease-query and address-registration counters. Every one of these is present
  in Kea's own `statistic-get-all` response.
- **Mistyped series.** Every metric it exports is a gauge, including the
  monotonic ones named `*_total`. `rate()` on a gauge gives no
  counter-reset handling, and Kea resets per-subnet counters on every
  configuration reload ([§3.2.9](#32-behaviours-that-shape-the-design)).

The failure mode that matters most in a Kea HA pair is also the hardest to see:

- **One server silently stops participating.** A standby stuck in `waiting`
  or `syncing`, or `terminated` because of clock skew, still looks healthy
  from the outside. The active server keeps answering, lease graphs stay flat
  and normal, and the pair has quietly lost its redundancy. Nothing changes
  until the active server fails and there is no partner to take over.
- **Both servers believe they are alone.** If both sides of a hot-standby pair
  move to `partner-down`, both serve the whole address space. Lease conflicts
  follow.
- **Failover is in progress.** While communication is interrupted, Kea counts
  unanswered clients towards a threshold before it moves to `partner-down`.
  That count is the clearest early warning available, and it is only visible
  through `status-get`.

**Intended outcome.** A standalone exporter that turns the Kea control API
into a correctly typed, labelled Prometheus metric surface, covering:

- HA state per relationship, designed first because it is the reason this
  exporter exists.
- Packet, drop, lease and utilisation counters for DHCPv4 and DHCPv6.
- DHCP-DDNS update outcomes.
- One honest health signal per Kea daemon.

It ships with standalone, Docker and Kubernetes deployment paths.

---

## 2. Requirements

### Functional

| | Requirement |
|---|---|
| **R1** | Export each HA relationship's local state as a state set, labelled so both sides of one relationship share a join key. |
| **R2** | Export partner reachability and failover-progress signals: communication-interrupted flag, unacked and remaining-before-failover client counts, partner's last reported state, clock skew. |
| **R3** | Export packets received and sent by message type as true Prometheus counters, including the aggregate totals. |
| **R4** | Export packet drops by reason, covering every drop reason Kea reports. |
| **R5** | Export address (v4), non-temporary address and delegated-prefix (v6) capacity and usage, globally, per subnet and per pool. |
| **R6** | Export allocation failures by cause, declines, reclamation, lease reuse and reservation conflicts. |
| **R7** | Export DHCP-DDNS name-change-request and DNS update outcomes. |
| **R8** | Expose **one Prometheus scrape target per Kea daemon control socket**, so per-daemon identity comes from Prometheus's own `instance` label. |
| **R9** | Expose a per-target health signal derived from actual API outcomes. |
| **R10** | Support IPv4 and IPv6 targets, HTTPS with a private CA, and a client certificate when Kea requires one. |

### Non-functional

| | Requirement |
|---|---|
| **N1** | Read-only against Kea. Not by convention: a mutating command must be unrepresentable in the code. |
| **N2** | A Prometheus scrape must never trigger an upstream API call. |
| **N3** | A failure or slow response from one target must not affect another. |
| **N4** | Least privilege, as far as Kea allows. Kea cannot scope a credential to read-only commands, so this is met by deployment controls ([§6.4](#64-least-privilege)). |
| **N5** | No secret may appear in logs, errors, metrics, configuration summaries or diagnostic dumps. |
| **N6** | Health signals must be honest. A metric indicating success must be derived from an actual success; no code path assigns one a constant. |
| **N7** | Bounded label cardinality, with a tripwire metric that makes growth visible. |
| **N8** | Metric names are stable within a major version, independent of upstream naming changes. |

---

## 3. Upstream API behaviour this design is built on

The behaviours below are current as of Kea 3.2.0, the stable series this
exporter is designed and tested against. Kea 3.3 is a development series and
is not a target.

### 3.1 Commands used

Every Kea command carries an `access` classification of `read` or `write` in
its API definition (`KEA/src/share/api/*.json`). This exporter uses only
`read` commands.

| Command | Daemons | Access | Hook required | Purpose |
|---|---|---|---|---|
| `version-get` | dhcp4, dhcp6, d2 | read | none | Server version |
| `status-get` | dhcp4, dhcp6, d2 | read | none (HA section needs `libdhcp_ha`) | Uptime, reload time, service and socket state, multi-threading, **HA state** |
| `statistic-get-all` | dhcp4, dhcp6, d2 | read | none | All statistics: packets, drops, leases, pools, DDNS |
| `config-hash-get` | dhcp4, dhcp6, d2 | read | none | Configuration change detection. Only when subnet labels are enabled ([§5.6](#56-subnet-prefix-and-shared-network-labels)) |
| `subnet4-list` / `subnet6-list` | dhcp4 / dhcp6 | read | `libdhcp_subnet_cmds` | Subnet ID to prefix and shared-network mapping. Only when subnet labels are enabled |

All hooks used here are open source as of Kea 3.0 (ARM `hooks.html`).

### 3.2 Behaviours that shape the design

1. **There is no Control Agent.** Since Kea 2.7.2, each daemon (`kea-dhcp4`,
   `kea-dhcp6`, `kea-dhcp-ddns`) has its own HTTP or HTTPS control channel
   configured under `control-sockets`. The separate `kea-ctrl-agent` was
   removed in 3.1.8 (ARM `ctrl-channel.html`). Each daemon therefore listens on
   its own address and port, and **one target is one daemon socket** (R8).

2. **Requests are `POST /` with a JSON body.** The body is
   `{"command": "<name>"}`, optionally with `arguments`. The parser accepts
   only `command`, `arguments`, `service` and `remote-address` at the top
   level and rejects anything else (`KEA/src/lib/cc/command_interpreter.cc`).
   `service` is meaningful only to the removed Control Agent and is never
   sent. None of the commands in [§3.1](#31-commands-used) as used here takes
   arguments.

3. **The response is an array, except on authentication failure.** A normal
   response is a one-element JSON array, kept for compatibility with the
   removed Control Agent (`KEA/src/lib/config/cmd_response_creator.cc`). An
   authentication or authorisation failure returns a bare JSON object,
   `{"result": 403, "text": "Forbidden"}`. The envelope parser accepts exactly
   these two shapes and treats anything else as a parse failure.

4. **The result code, not the HTTP status, carries the outcome.** Each
   response element carries an integer `result`:

   | Code | Meaning | Exporter treatment |
   |---|---|---|
   | 0 | success | ok |
   | 1 | error | `api_error` |
   | 2 | command unsupported | **not an error**: the hook is not loaded; `kea_command_supported{command} 0` |
   | 3 | success, resource empty | **not an error**: an empty result |
   | 4 | conflict with server state | `api_error` |
   | 5 | partial change, rollback failed | `api_error` (only possible on write commands, so never expected) |

   Hooks may return other codes; any unlisted code is `api_error`.

5. **Basic authentication is all-or-nothing.** `authentication.type: basic`
   with a `clients` list is the only access control in open-source Kea. Every
   authenticated client can run every command, including writes such as
   `config-set`, `shutdown`, `lease4-del` and the HA maintenance commands.
   Per-command access control requires the RBAC hook (`libdhcp_rbac`), which
   is available only to ISC support subscribers (ARM `hooks.html`). The
   exporter's credential is therefore an administrative credential by
   construction. [§6.3](#63-read-only-enforcement) and [§6.4](#64-least-privilege)
   are written around that fact.

6. **Kea 3.x refuses clear-text credentials and unauthenticated HTTP sockets.**
   By default a daemon treats either as a security policy violation and exits
   (`KEA/doc/sphinx/arm/security.rst`). In practice the Kea side uses
   `user-file`/`password-file`, and every deployable target requires
   authentication.

7. **`config-get` returns secrets in plaintext.** The manual states that the
   returned configuration is not redacted and contains database passwords
   (ARM `ctrl-channel.html`). It is a permanent non-goal ([§4.2](#42-scope)).
   `config-hash-get` provides change detection without any configuration
   content.

8. **`ha-heartbeat` is a `write` command.** It is the HA hook's
   partner-to-partner probe. `status-get` already reports both the local
   server's state and the partner's last known state, so the exporter takes
   all HA data from `status-get` and never calls `ha-heartbeat`.

9. **A configuration reload resets per-subnet and per-pool statistics.** On
   every configuration commit Kea deletes the statistics of the outgoing
   configuration's subnets and pools and recreates them for the new one
   (`KEA/src/lib/dhcpsrv/cfgmgr.cc`, `cfg_subnets4.cc`). Per-subnet
   cumulative and reclaimed counters fall back to zero. These are exported as
   true counters, so `rate()` and `increase()` treat the drop as a counter
   reset. Global counters survive a reload. `status-get` reports seconds
   since the last reload, which is exported so a reset is explainable.

10. **Statistics are keyed by subnet ID, not by prefix.** Per-subnet and
    per-pool names have the form `subnet[<id>].<name>`,
    `subnet[<id>].pool[<pid>].<name>` and, for DHCPv6 prefix delegation,
    `subnet[<id>].pd-pool[<pid>].<name>`. No statistic name carries a prefix
    or a shared-network name. Those come only from `subnet4-list` or
    `subnet6-list`, which need the `subnet_cmds` hook.

11. **Each statistic carries a sample history.** `statistic-get-all` returns
    `{"<name>": [[value, "<timestamp>"], ...]}` with up to 20 samples per
    statistic by default, newest first (`KEA/src/lib/stats/observation.cc`).
    The exporter reads only the first sample. The payload scales with
    statistics × samples, so the install guides recommend setting the
    daemon's default sample count to 1. The exporter never sets it itself,
    because the setter commands are `write` commands.

12. **Statistic timestamps are local time with no zone designator.** They are
    formatted `YYYY-MM-DD HH:MM:SS.ffffff` from `localtime_r`
    (`KEA/src/lib/util/chrono_time_utils.cc`). They are not used. Freshness
    comes from the exporter's own poll timestamp.

13. **Some values exceed 2^53.** Kea stores large statistics as 128-bit
    integers; `total-nas` for a single `/64` pool is 2^64. JSON numbers of
    that size parse to the nearest IEEE-754 double. Prometheus sample values
    are float64 in any case, so the precision lost is precision Prometheus
    could not have stored. It is documented, not worked around.

14. **Statistics exist only for what has happened or is configured.** Kea
    creates a statistic on first use. A daemon that has never received a
    `DHCPINFORM` may have no `pkt4-inform-received` entry at all. A missing
    statistic is exported as an **absent series**, never as zero, except
    where [§5](#5-metric-surface) states otherwise.

    A live capture against Kea 3.2.1 confirmed this applies per subnet too.
    The global `v4-allocation-fail*` statistics existed from startup, but no
    subnet carried its own `v4-allocation-fail*` entries until a failure
    occurred in it. Alerts on allocation failures therefore key on the
    global counter, which always exists, rather than the per-subnet one.

    `status-get` may also carry fields this design does not use, such as a
    lease-file path on a memfile-backed server. Unused fields are ignored,
    never exported.

15. **The HA section of `status-get` is per relationship.** `arguments.high-availability`
    is an array with one entry per HA relationship the server takes part in.
    A server in a hub-and-spoke topology has several. Each entry carries
    `ha-mode`, a `local` block (`role`, `state`, `scopes`, `server-name`) and,
    when a partner exists, a `remote` block (`role`, `last-state`,
    `last-scopes`, `server-name`, `communication-interrupted`, `in-touch`,
    `age`, `clock-skew`, `connecting-clients`, `unacked-clients`,
    `unacked-clients-left`, `analyzed-packets`) (ARM `hooks.html`). The
    `remote` block is optional in this design's parser: its absence is a
    valid state, not a parse failure.

### 3.3 Bounded enumerations

| Set | Values |
|---|---|
| HA state | `backup`, `communication-recovery`, `hot-standby`, `in-maintenance`, `load-balancing`, `partner-down`, `partner-in-maintenance`, `passive-backup`, `ready`, `syncing`, `terminated`, `unavailable`, `waiting` (`KEA/src/hooks/dhcp/high_availability/ha_service_states.cc`) |
| HA mode | `load-balancing`, `hot-standby`, `passive-backup` |
| HA role | `primary`, `secondary`, `standby`, `backup` |
| Control socket status | `ready`, `retrying`, `failed` |
| Daemon | `dhcp4`, `dhcp6`, `d2` |

Each is exported as a **state set**: one series per possible value, with exactly
one set to `1`. None is exported as a single gauge holding a numeric code. A
numeric enum gauge cannot distinguish an unrecognised value from a known one,
and leaves a stale number behind when a value stops being reported.
Unrecognised values increment `kea_exporter_unknown_enum_total{metric,value}`
and are otherwise dropped.

Label values keep Kea's own spelling, hyphens included (`partner-down`,
`hot-standby`, `queue-full`). An operator reading a Kea log and a Prometheus
query should see the same word.

### 3.4 Supported server versions

**Designed and tested against Kea 3.2.x.** Kea 3.0 and 3.1 expose the same
commands and are supported on a best-effort basis. Earlier releases either
require the removed Control Agent or predate the per-daemon HTTP channel, and
are out of scope.

The version is read per target at startup and after every detected daemon
restart. A version below 3.0.0 logs an error and sets
`kea_server_version_supported 0` for that target rather than exiting. One
legacy daemon must not stop the exporter serving the others.

---

## 4. Architecture

### 4.1 Poll, cache, serve

A background poll loop per target writes an immutable snapshot to an in-memory
cache. `/metrics?target=<name>` renders from that snapshot (N2).

This is enforced structurally rather than by discipline: no object in the
HTTP-server layer is given an API client, so no render path can reach the
network even by mistake.

### 4.2 Scope

**Included**

| Collector | Command | Default cadence | Default state |
|---|---|---|---|
| Status | `status-get` | every poll (30 s) | on. Supplies `kea_up` |
| High availability | `status-get` (same call) | every poll | on whenever the HA hook is loaded |
| Statistics | `statistic-get-all` | every poll | on |
| Per-pool statistics | `statistic-get-all` (same call) | every poll | on (`ENABLE_POOL_STATS`) |
| Version | `version-get` | startup, and after a detected restart | on |
| Subnet labels | `config-hash-get`, `subnet4-list` / `subnet6-list` | hash every poll; list on hash change | **off** ([§5.6](#56-subnet-prefix-and-shared-network-labels)) |
| DDNS per-key split | `statistic-get-all` (same call) | every poll | **off** ([§5.7](#57-dhcp-ddns)) |

One poll cycle against a target costs one `status-get` and one
`statistic-get-all` by default.

**Excluded: permanent non-goals, not deferrals**

- **`config-get`, and any configuration content.** The response contains
  plaintext secrets ([§3.2.7](#32-behaviours-that-shape-the-design)). A
  read-only, secret-free exporter does not call an endpoint whose response
  includes credentials.
- **Every `write` command, including `ha-heartbeat`.** See [§3.2.8](#32-behaviours-that-shape-the-design).
  This also rules out setting the statistics sample count on the operator's
  behalf.
- **Lease contents** (`lease4-get-all`, `lease4-get-page` and their v6
  equivalents). Unbounded cardinality, and exporting them would write client
  hardware addresses, client identifiers and hostnames into a metrics store.
  Aggregate lease counts are already provided by the statistics.
- **Host reservations, client classes, option data.** Configuration, not health.
- **The Kea Control Agent.** Removed upstream ([§3.2.1](#32-behaviours-that-shape-the-design)).
- **Statistic sample history.** Only the current value is a metric. History is
  Prometheus's job.
- **Subnet prefixes and shared-network names by default.** They are available
  opt-in ([§5.6](#56-subnet-prefix-and-shared-network-labels)). A compromised
  metrics store should not become an inventory of internal address plans
  unless the operator chooses that trade.
- **HA partner URLs.** HA configuration names each peer's URL. `status-get`
  does not return it, and the exporter does not obtain it any other way.

### 4.3 Multi-target model

One Prometheus scrape target per Kea daemon control socket.

- Targets are **named** in configuration. The name is the `?target=` value and
  becomes Prometheus's `instance` label through relabeling.
- `GET /metrics?target=dhcp4-a` renders that target only.
- `GET /metrics` with no parameter renders the **global** registry alone:
  Node.js runtime metrics, `kea_exporter_build_info` and
  `kea_exporter_targets`. It does not aggregate targets.
- An unknown `?target=` returns **400**, never an empty 200. A typo in a scrape
  configuration must fail loudly.
- **There is no `module` parameter.** Each control socket belongs to exactly
  one daemon, so the daemon type is a property of the target, set in
  configuration and verified against the target's own statistics
  ([§5.1](#51-per-target-health)). A `module` parameter would let a scrape
  configuration ask a DHCPv6 socket for DHCPv4 metrics; making that
  unrepresentable is simpler than validating it.

Because per-target identity comes from `instance`, the exporter never attaches
a constant `instance` label of its own. There is therefore no
`exported_instance` collision and no dependence on `honor_labels`.

```yaml
scrape_configs:
  - job_name: kea
    metrics_path: /metrics
    static_configs:
      - targets: [dhcp4-a, dhcp4-b, dhcp6-a, dhcp6-b, d2-a]
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: kea-metrics-exporter:10167
```

Discovery through pod annotations is not supported for the per-target
endpoint. Annotation-based discovery scrapes the exporter's own address with
no `target` parameter, so it only ever collects the global registry.

### 4.4 One registry per target

Each target owns its own `@prometheus-io/client` `Registry`. This delivers three
properties at once:

1. **Isolation (N3).** A label-set change or render failure for one target
   cannot affect another target's response.
2. **Correct series disappearance.** The render path resets that target's
   collector metrics and repopulates them from the snapshot. A deleted subnet,
   a removed pool or a dissolved HA relationship stops being exported rather
   than freezing at its last observed value.
3. **No cross-target label-dimension conflicts.** A DHCPv4 and a DHCPv6 target
   never share a registry, so their differing families cannot collide.

Poll loops are independent for the same reason: per-target startup jitter,
per-target failure state, per-target error classification. A hard-down daemon
never delays or fails another target's cycle.

### 4.5 Technology

- Node.js **≥ 24**, TypeScript **7.x**, ESM, `strict` plus
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Runtime dependencies: **`@prometheus-io/client`** (the official Prometheus
  client library for Node.js) and **`undici`**, and nothing else. No web
  framework, no CLI library, no native addons. A guard script enforces the
  last, run in CI.
- `node:http` and `node:https` directly for the metrics listener.
- Tests via `node:test`. Lint and format via Biome.
- Apache-2.0.

Default listen port **10167**, checked free against the Prometheus default-port
allocation registry ([§9](#9-open-questions)). It is deliberately not 9547,
which the registry assigns to the Stork agent's Kea exporter, so that both can
run on one host during a migration.

---

## 5. Metric surface

Prefix `kea_` for Kea data and `kea_exporter_` for the exporter's own health.
DHCPv4 statistics use `kea_dhcp4_`, DHCPv6 `kea_dhcp6_` and DHCP-DDNS
`kea_d2_`. `METRICS.md` is generated from the live metric declarations, with a
test asserting the committed file matches a fresh generation, so the reference
cannot drift from the code.

Naming rules applied throughout:

- Counters end in `_total`. Nothing else does.
- Counts of things currently in a state (assigned addresses, connecting
  clients) are unitless gauges.
- Durations and timestamps are in seconds and say so in the name.
- Ratios such as pool utilisation are not exported. They are a division in
  PromQL, and exporting them would duplicate their two inputs.

### 5.1 Per-target health

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `kea_up` | gauge | — | 1 if and only if the last cycle's `status-get` reached the daemon, **and** the credential was accepted, **and** it returned result 0 (N6) |
| `kea_collector_success` | gauge | `collector` | Per-collector outcome, so "status fine, statistics failing" is visible rather than collapsed into one boolean |
| `kea_server_version_info` | gauge | `version`, `daemon` | Always 1 |
| `kea_server_version_supported` | gauge | — | 0 below 3.0.0 |
| `kea_daemon_mismatch` | gauge | — | 1 when the configured daemon type disagrees with the one observed |
| `kea_command_supported` | gauge | `command` | 0 when the daemon answers result 2 (hook not loaded), for optional commands only |
| `kea_start_time_seconds` | gauge | — | Poll time minus `uptime`, rounded to whole seconds |
| `kea_config_reload_timestamp_seconds` | gauge | — | Poll time minus `reload`, rounded to whole seconds |
| `kea_service_globally_disabled` | gauge | — | `dhcp-state.globally-disabled`. DHCP daemons only |
| `kea_service_disabled` | gauge | `origin` | One series each for `user`, `local-command`, `remote-command` and `db-connection`. 1 when that origin holds the service disabled. DHCP daemons only |
| `kea_control_socket_status` | gauge | `status` | State set over `ready`, `retrying`, `failed` |
| `kea_multi_threading_enabled` | gauge | — | |
| `kea_thread_pool_size` | gauge | — | Absent when multi-threading is off |
| `kea_packet_queue_size` | gauge | — | Configured capacity. Absent when multi-threading is off |
| `kea_packet_queue_depth_avg` | gauge | `window` | `packet-queue-statistics`: average queue depth over the last 10, 100 and 1000 packets |

`kea_up` describes the Kea daemon. Prometheus's own `up` describes the
exporter. They mean different things and both are needed: only `up` can fire
when the exporter process itself is gone.

**Daemon verification.** The configured daemon type is checked on every cycle
against the statistics names the target actually returns: `pkt4-` for DHCPv4,
`pkt6-` for DHCPv6, `ncr-` for DHCP-DDNS. A mismatch sets
`kea_daemon_mismatch 1` and `kea_collector_success{collector="statistics"} 0`.
It does not render the other daemon's families, because a target mapped to the
wrong daemon is a configuration error and rendering it would be misleading. A
daemon with no traffic yet may return none of these prefixes. That case is
inconclusive, not a mismatch.

The two timestamps are derived from relative values: poll time minus a
whole-second `uptime` or `reload`. Rounding alone was observed live to leave
them wobbling by a second between polls, which `changes()` would count as
restarts or reloads. A newly derived value within two seconds of the last
published one therefore keeps the last value. A real restart or reload moves
it far further, so `changes(kea_config_reload_timestamp_seconds[1h])` counts
reloads.

### 5.2 High availability

This section is the reason the exporter exists, and was designed before any
other part of the metric surface.

**Label model.** Every HA series carries:

| Label | Source | Purpose |
|---|---|---|
| `server` | `local.server-name` | This server's name in the relationship |
| `partner` | `remote.server-name` | The partner's name. Absent on series that describe only the local side |
| `relationship` | the two names sorted and joined with `+` | A join key that is **identical on both sides** of one relationship |

The `relationship` label is what makes cross-server rules possible. Server A
reports `server="server1", partner="server2"`; server B reports
`server="server2", partner="server1"`. Both report
`relationship="server1+server2"`, so `count by (relationship)` and
`max by (relationship)` group the pair without relabeling. A hub in a
hub-and-spoke topology reports one `relationship` per spoke. Backup servers
are not reported in the `remote` block, so they do not appear in the key.

Server names come from Kea configuration and are bounded by it (N7).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `kea_ha_relationships` | gauge | — | Number of entries in `high-availability[]`. Absent when the HA hook is not loaded |
| `kea_ha_relationship_info` | gauge | `relationship`, `server`, `partner`, `mode`, `role`, `partner_role` | Always 1. `partner` and `partner_role` are empty when there is no `remote` block |
| `kea_ha_state` | gauge | `relationship`, `server`, `state` | **State set** over all 13 HA states: the local server's state |
| `kea_ha_scopes_served` | gauge | `relationship`, `server` | Number of scopes the local server is currently serving |
| `kea_ha_scope_served` | gauge | `relationship`, `server`, `scope` | 1 per scope in `local.scopes` |
| `kea_ha_partner_last_state` | gauge | `relationship`, `partner`, `state` | **State set**: the partner's state as last learned by this server |
| `kea_ha_partner_last_scope` | gauge | `relationship`, `partner`, `scope` | 1 per scope in `remote.last-scopes` |
| `kea_ha_communication_interrupted` | gauge | `relationship`, `partner` | 1 when no successful contact for longer than `max-response-delay` |
| `kea_ha_partner_in_touch` | gauge | `relationship`, `partner` | `remote.in-touch` |
| `kea_ha_partner_age_seconds` | gauge | `relationship`, `partner` | `remote.age` ([§9](#9-open-questions)) |
| `kea_ha_clock_skew_seconds` | gauge | `relationship`, `partner` | Partner time minus local time. Signed |
| `kea_ha_connecting_clients` | gauge | `relationship`, `partner` | Distinct clients observed trying to reach the partner while communication is interrupted |
| `kea_ha_unacked_clients` | gauge | `relationship`, `partner` | Of those, clients the partner has failed to answer |
| `kea_ha_unacked_clients_left` | gauge | `relationship`, `partner` | Further unanswered clients before this server moves to `partner-down` |
| `kea_ha_analyzed_packets` | gauge | `relationship`, `partner` | Packets examined since communication was interrupted |

Every `partner`-labelled series is absent when the `remote` block is absent.
That is distinct from a partner reporting zero.

The failover counters (`connecting`, `unacked`, `unacked-left`, `analyzed`)
are gauges, not counters. Kea resets them whenever communication is restored,
so they describe the current interruption, not a lifetime total.

**HA-hook-absent behaviour.** A target without the HA hook returns no
`high-availability` key. Every `kea_ha_*` series is absent, and
`kea_collector_success{collector="ha"}` is absent too: a daemon that has no HA
to report is not a failing collector. A target that previously reported HA
and stops (hook unloaded by a reload) drops every `kea_ha_*` series on the
next render.

**Worked PromQL.** These are the queries the shipped alerts are built on
([§7](#7-dashboard-and-alerting)):

```promql
# No server in a relationship is serving any scope. Only targets that are up
# count: a down target's series keep their last values (§5.8), so a primary
# that died while serving would otherwise still count as serving.
max by (relationship) (
  kea_ha_scopes_served and on (job, instance) kea_up == 1
) == 0

# Split brain: more than one side of a relationship believes its partner is down.
# Deduplicated by server first, so two exporters scraping one daemon during a
# migration cannot count one server twice.
count by (relationship) (
  max by (relationship, server) (
    kea_ha_state{state="partner-down"} and on (job, instance) kea_up == 1
  ) == 1
) > 1

# A server stuck outside its operational states.
max_over_time(kea_ha_state{state=~"waiting|syncing|ready"}[15m]) == 1
  and min_over_time(kea_ha_state{state=~"waiting|syncing|ready"}[15m]) == 1

# Failover is imminent.
kea_ha_communication_interrupted == 1 and kea_ha_unacked_clients_left <= 2
```

Kea's own clock-skew policy is worth stating next to the metric: the HA hook
logs a warning above 30 seconds of skew and moves to `terminated` above 60
seconds (ARM `hooks.html`). `terminated` persists until the daemon is
restarted, so a skew that is fixed later still leaves the pair degraded.

### 5.3 DHCPv4 packets and drops

| Metric | Type | Labels | Source |
|---|---|---|---|
| `kea_dhcp4_packets_received_all_total` | counter | — | `pkt4-received` |
| `kea_dhcp4_packets_received_total` | counter | `type` | `pkt4-<type>-received`, for `discover`, `offer`, `request`, `ack`, `nak`, `release`, `decline`, `inform`, `lease-query`, `unknown` |
| `kea_dhcp4_packets_sent_all_total` | counter | — | `pkt4-sent` |
| `kea_dhcp4_packets_sent_total` | counter | `type` | `pkt4-<type>-sent`, for `offer`, `ack`, `nak`, `lease-query-response-unassigned`, `lease-query-response-unknown`, `lease-query-response-active` |
| `kea_dhcp4_packets_dropped_all_total` | counter | — | `pkt4-receive-drop` |
| `kea_dhcp4_packets_dropped_total` | counter | `reason` | `pkt4-<reason>`, for `parse-failed`, `queue-full`, `duplicate`, `rfc-violation`, `admin-filtered`, `not-for-us`, `processing-failed`, `limit-exceeded`, `service-disabled` |

The aggregate counters are separate metrics rather than a reserved label value.
Summing `kea_dhcp4_packets_received_total` across `type` must not double-count
the aggregate. Whether `parse-failed` is included in `receive-drop` is not
documented, so no dashboard or alert assumes the reasons sum to the aggregate.

### 5.4 DHCPv6 packets and drops

Same shape as [§5.3](#53-dhcpv4-packets-and-drops), prefix `kea_dhcp6_`, sourced
from `pkt6-*`.

- `type` for received packets: `solicit`, `advertise`, `request`, `reply`,
  `renew`, `rebind`, `release`, `decline`, `infrequest`, `lease-query`,
  `dhcpv4-query`, `dhcpv4-response`, `addr-reg-inform`, `addr-reg-reply`,
  `unknown`.
- `type` for sent packets: `advertise`, `reply`, `lease-query-reply`,
  `dhcpv4-response`, `addr-reg-reply`.
- `reason`: the same nine drop reasons as DHCPv4.

### 5.5 Leases, utilisation and allocation

Three scopes per family: global (no subnet labels), per subnet (`subnet_id`),
per pool (`subnet_id`, `pool_id`). Pool series are controlled by
`ENABLE_POOL_STATS` (default on).

**DHCPv4**

| Metric stem | Type | Global | Subnet | Pool | Source statistic |
|---|---|:-:|:-:|:-:|---|
| `addresses` | gauge | | ✓ | ✓ | `total-addresses` |
| `addresses_assigned` | gauge | ✓ | ✓ | ✓ | `assigned-addresses` |
| `addresses_declined` | gauge | ✓ | ✓ | ✓ | `declined-addresses` |
| `assignments_total` | counter | ✓ | ✓ | ✓ | `cumulative-assigned-addresses` |
| `reclaimed_leases_total` | counter | ✓ | ✓ | ✓ | `reclaimed-leases` |
| `reclaimed_declined_addresses_total` | counter | ✓ | ✓ | ✓ | `reclaimed-declined-addresses` |
| `allocation_failures_total` | counter | ✓ | ✓ | | `v4-allocation-fail` |
| `allocation_failures_by_cause_total{cause}` | counter | ✓ | ✓ | | `v4-allocation-fail-<cause>`, for `shared-network`, `subnet`, `no-pools`, `classes` |
| `lease_reuses_total` | counter | ✓ | ✓ | | `v4-lease-reuses` |
| `reservation_conflicts_total` | counter | ✓ | ✓ | | `v4-reservation-conflicts` |

Full names follow `kea_dhcp4_<stem>` (global), `kea_dhcp4_subnet_<stem>` and
`kea_dhcp4_pool_<stem>`. For example: `kea_dhcp4_subnet_addresses_assigned`,
`kea_dhcp4_pool_assignments_total`.

**DHCPv6**

| Metric stem | Type | Global | Subnet | Pool | PD pool | Source statistic |
|---|---|:-:|:-:|:-:|:-:|---|
| `nas` | gauge | | ✓ | ✓ | | `total-nas` |
| `nas_assigned` | gauge | ✓ | ✓ | ✓ | | `assigned-nas` |
| `pds` | gauge | | ✓ | | ✓ | `total-pds` |
| `pds_assigned` | gauge | ✓ | ✓ | | ✓ | `assigned-pds` |
| `addresses_declined` | gauge | ✓ | ✓ | ✓ | | `declined-addresses` |
| `na_assignments_total` | counter | ✓ | ✓ | ✓ | | `cumulative-assigned-nas` |
| `pd_assignments_total` | counter | ✓ | ✓ | | ✓ | `cumulative-assigned-pds` |
| `reclaimed_leases_total` | counter | ✓ | ✓ | ✓ | ✓ | `reclaimed-leases` |
| `reclaimed_declined_addresses_total` | counter | ✓ | ✓ | ✓ | | `reclaimed-declined-addresses` |
| `allocation_failures_total` | counter | ✓ | ✓ | | | `v6-allocation-fail` |
| `allocation_failures_by_cause_total{cause}` | counter | ✓ | ✓ | | | `v6-allocation-fail-<cause>` |
| `lease_reuses_total{ia_type}` | counter | ✓ | ✓ | | | `v6-ia-na-lease-reuses` (`ia_type="na"`), `v6-ia-pd-lease-reuses` (`ia_type="pd"`) |
| `registered` | gauge | | ✓ | | | `registered` |
| `registrations_total` | counter | ✓ | ✓ | | | `cumulative-registered` |

Full names follow `kea_dhcp6_<stem>`, `kea_dhcp6_subnet_<stem>`,
`kea_dhcp6_pool_<stem>` and `kea_dhcp6_pd_pool_<stem>`. Prefix-delegation pool
series carry `pool_id` from the `pd-pool[<pid>]` index.

**Counter semantics across reloads.** Per-subnet and per-pool counters reset on
every configuration reload ([§3.2.9](#32-behaviours-that-shape-the-design)).
They are exported as counters precisely so that Prometheus handles this
correctly. A subnet whose ID is reused for a different prefix after a reload
continues the same series. The exporter cannot detect that, and documents it:
alerts on per-subnet counters use `rate()` windows short enough that one reload
does not distort them.

**Cardinality cap.** `MAX_SUBNETS` (default 2048) bounds the number of subnets
rendered per target. Subnets beyond the cap are dropped in ascending subnet-ID
order, so the retained set is deterministic. The number dropped is exported as
`kea_exporter_subnets_truncated`. Global series are never truncated.

### 5.6 Subnet prefix and shared-network labels

Off by default (`ENABLE_SUBNET_LABELS=false`), for the reason given in
[§4.2](#42-scope).

When enabled, every `kea_dhcp4_subnet_*`, `kea_dhcp4_pool_*`,
`kea_dhcp6_subnet_*`, `kea_dhcp6_pool_*` and `kea_dhcp6_pd_pool_*` series gains
`prefix` (the subnet's CIDR) and `shared_network` (empty when the subnet is not
in one). The mapping comes from `subnet4-list` / `subnet6-list`, which needs
the `subnet_cmds` hook.

- The mapping is fetched at startup and again whenever `config-hash-get`
  reports a changed hash, so a reload that renumbers subnets relabels them on
  the next cycle.
- If the hook is not loaded, the command returns result 2. The exporter sets
  `kea_command_supported{command="subnet4-list"} 0`, logs one warning, and
  renders subnet series without the extra labels. It does not retry every
  cycle.
- Result 3 (no subnets configured) is an empty mapping, not an error.
- A subnet ID present in the statistics but missing from the mapping is
  rendered with empty `prefix` and `shared_network`. That is the expected
  state for one cycle after a reload, until the hash change triggers a refresh.

Enabling this flag changes the label set of existing series. The install guide
says so, and the `CHANGELOG.md` convention treats a default change here as a
breaking change ([§10](#10-stability-commitment)).

### 5.7 DHCP-DDNS

| Metric | Type | Source |
|---|---|---|
| `kea_d2_ncr_received_total` | counter | `ncr-received` |
| `kea_d2_ncr_invalid_total` | counter | `ncr-invalid` |
| `kea_d2_ncr_errors_total` | counter | `ncr-error` |
| `kea_d2_queue_full_total` | counter | `queue-mgr-queue-full` |
| `kea_d2_updates_sent_total` | counter | `update-sent` |
| `kea_d2_updates_signed_total` | counter | `update-signed` |
| `kea_d2_updates_unsigned_total` | counter | `update-unsigned` |
| `kea_d2_updates_succeeded_total` | counter | `update-success` |
| `kea_d2_updates_timed_out_total` | counter | `update-timeout` |
| `kea_d2_updates_failed_total` | counter | `update-error` |

`ENABLE_D2_KEY_STATS` (default off) adds `kea_d2_key_updates_*_total{key}` from
the per-TSIG-key `key[<name>].update-*` statistics. Key names are configuration
identifiers, not key material, and are bounded by configuration. They are
nevertheless opt-in because they describe the DNS security configuration. Key
secrets are never available through statistics.

The DDNS statistic names above are taken from the Kea documentation and are
confirmed against a live daemon in Phase 15 ([§9](#9-open-questions)).

`status-get` on the DDNS daemon reports process state only (no `dhcp-state`,
no multi-threading, no HA). The [§5.1](#51-per-target-health) series it cannot
supply are absent for `d2` targets.

### 5.8 Unrecognised statistics

Any statistic name that does not map to a declared metric increments
`kea_exporter_unknown_statistic_total{name}`. Subnet and pool indices are
templated out before the name becomes a label value:
`subnet[12].pool[3].foo` becomes `subnet[*].pool[*].foo`. The label is then
bounded by Kea's statistic catalogue rather than by the number of subnets.

This turns the next upstream addition or rename into a visible signal rather
than a silent gap. A missing expected statistic in an otherwise successful
response is not a parse failure: that one series is absent and everything else
renders.

On a fully failed poll cycle (daemon unreachable, credential rejected), every
already-registered counter and gauge holds its last known value rather than
resetting, the same way Prometheus treats a briefly unreachable target. Only a
field missing from an otherwise successful response goes absent.

### 5.9 Exporter self-observability

Per target:

| Metric | Type | Labels |
|---|---|---|
| `kea_exporter_last_successful_poll_timestamp_seconds` | gauge | — |
| `kea_exporter_cache_age_seconds` | gauge | — (computed at collect time from a monotonic clock) |
| `kea_exporter_poll_total` | counter | — |
| `kea_exporter_poll_errors_total` | counter | `reason` |
| `kea_exporter_poll_duration_seconds` | histogram | — |
| `kea_exporter_upstream_requests_total` | counter | `command`, `status_code` |
| `kea_exporter_upstream_request_duration_seconds` | histogram | `command` |
| `kea_exporter_upstream_response_bytes` | gauge | `command` (size of the last response) |
| `kea_exporter_parse_errors_total` | counter | `group` |
| `kea_exporter_unknown_enum_total` | counter | `metric`, `value` |
| `kea_exporter_unknown_statistic_total` | counter | `name` |
| `kea_exporter_subnets_truncated` | gauge | — |
| `kea_exporter_series` | gauge | — (the cardinality tripwire, N7) |
| `kea_exporter_tls_verification_disabled` | gauge | — |

Global: `kea_exporter_build_info{version,commit,node_version}`,
`kea_exporter_targets`, and Node.js runtime metrics.

`status_code` is the numeric HTTP status when the attempt received a response,
or one of the literal strings `timeout` and `network` when it did not.

`reason` is a bounded set: `auth`, `timeout`, `network`, `http_4xx`,
`http_5xx`, `too_large`, `parse`, `api_error`, `unknown`. `api_error` exists
because a Kea error is an HTTP 200 carrying a non-zero `result`
([§3.2.4](#32-behaviours-that-shape-the-design)), which a status-code-only
taxonomy cannot express. `too_large` is a response exceeding
`MAX_RESPONSE_BYTES`. Result 2 and result 3 are not errors and never appear
here.

### 5.10 Mapping from the Stork exporter's names

Operators migrating from the Stork agent's exporter need a translation, not
just a new name list. `METRICS.md` carries the full table. Its shape:

| Stork metric | Type there | This exporter | Type here |
|---|---|---|---|
| `kea_dhcp4_packets_received_total{operation="discover"}` | gauge | `kea_dhcp4_packets_received_total{type="discover"}` | counter |
| `kea_dhcp4_packets_received_total{operation="drop"}` | gauge | `kea_dhcp4_packets_dropped_all_total` | counter |
| `kea_dhcp4_packets_received_total{operation="parse-failed"}` | gauge | `kea_dhcp4_packets_dropped_total{reason="parse-failed"}` | counter |
| `kea_dhcp4_addresses_assigned_total{subnet_id="1",...}` | gauge | `kea_dhcp4_subnet_addresses_assigned{subnet_id="1"}` | gauge |
| `kea_dhcp4_cumulative_addresses_assigned_total{...}` | gauge | `kea_dhcp4_subnet_assignments_total` | counter |
| `kea_dhcp4_pool_addresses_total{pool_id="0",...}` | gauge | `kea_dhcp4_pool_addresses{pool_id="0"}` | gauge |
| *(not exported)* | | `kea_dhcp4_packets_received_all_total`, `kea_dhcp4_packets_dropped_total{reason="queue-full"}`, … | counter |
| *(not exported)* | | `kea_ha_*` | |

Some names exist in both exporters with a different meaning. The packet
counters keep their name but take `type` instead of `operation`. Stork's
per-subnet `kea_dhcp4_lease_reuses_total` and
`kea_dhcp4_reservation_conflicts_total` share their names with this
exporter's global counters. A query copied across keeps parsing and silently
returns something else, so `METRICS.md` lists every such name.

Where the type changes from gauge to counter, a query that used `rate()` on the
old gauge keeps working and gains correct reset handling. A query that used
the raw value of an old `*_total` gauge as a current count, such as assigned
addresses, moves to the unsuffixed gauge.

---

## 6. Configuration and security

Environment variables only, loaded once at startup, validated, then frozen. A
redacted effective-configuration summary is logged at startup. The full
reference lives in `example.env`.

### 6.1 Targets and credentials

```
KEA_TARGETS=dhcp4-a=https://kea-a.example.com:8004,dhcp4-b=https://kea-b.example.com:8004,dhcp6-a=https://[2001:db8::10]:8006
KEA_DAEMON=dhcp4
KEA_DAEMON__DHCP6_A=dhcp6
KEA_USERNAME=metrics
KEA_PASSWORD_FILE=/run/secrets/kea-password
KEA_PASSWORD_FILE__DHCP6_A=/run/secrets/kea-v6-password
KEA_CA_BUNDLE_PATH=/etc/kea-exporter/ca.pem
KEA_CLIENT_CERT_PATH=/etc/kea-exporter/client.pem
KEA_CLIENT_KEY_PATH=/etc/kea-exporter/client-key.pem
KEA_TLS_INSECURE_SKIP_VERIFY=false
```

- A target name matches `^[a-z0-9][a-z0-9_-]*$`, case-insensitive, and must be
  unique. The `__<NAME>` override suffix is the target name upper-cased with
  `-` replaced by `_`. Every per-target setting above accepts an override.
- **An override suffix matching no configured target is a startup error**, not
  a silently ignored variable. Otherwise a typo means a daemon quietly uses the
  wrong credential, the wrong daemon type, or no CA bundle at all.
- `KEA_DAEMON` is one of `dhcp4`, `dhcp6`, `d2`, and has no default. Every
  target must resolve to a daemon type, either through the global value or an
  override.
- A base URL is an opaque prefix: never parsed for anything but scheme
  validation, never reconstructed. IPv6 literals are supplied bracketed, as in
  any URL. Plain `http:` is accepted, because Kea supports HTTP control
  sockets, but logs a startup warning: the basic-auth credential then crosses
  the network in clear text.
- `KEA_PASSWORD` and `KEA_PASSWORD_FILE` are mutually exclusive per target.
  The file form is preferred and is what the Kubernetes manifests use. The file
  is read once at startup; rotating it means restarting the exporter.
- Kea's HTTPS sockets default to `cert-required: true`, which demands a client
  certificate (ARM `security.html`). `KEA_CLIENT_CERT_PATH` and
  `KEA_CLIENT_KEY_PATH` supply one. Key material is only ever read from a file
  path, never from an environment variable's value.
- `KEA_TLS_INSECURE_SKIP_VERIFY` logs a loud startup warning and sets
  `kea_exporter_tls_verification_disabled 1`, so a temporary workaround cannot
  become invisible permanent state.

### 6.2 Behaviour

```
METRICS_PORT=10167
METRICS_BIND_ADDRESS=0.0.0.0
POLL_INTERVAL_SECONDS=30            # floor 5
REQUEST_TIMEOUT_SECONDS=15
MAX_RESPONSE_BYTES=67108864         # 64 MiB
MAX_SUBNETS=2048
ENABLE_POOL_STATS=true
ENABLE_SUBNET_LABELS=false
ENABLE_D2_KEY_STATS=false
ENABLE_DEFAULT_METRICS=true
LOG_LEVEL=info
LOG_FORMAT=json
METRICS_TLS_CERT_PATH=
METRICS_TLS_KEY_PATH=
METRICS_TLS_CLIENT_CA_PATH=
METRICS_TLS_MIN_VERSION=TLSv1.2
```

`MAX_RESPONSE_BYTES` exists because `statistic-get-all` scales with
subnets × pools × sample count ([§3.2.11](#32-behaviours-that-shape-the-design)).
A response above the cap is abandoned mid-stream and counted as `too_large`,
rather than being buffered without bound.

### 6.3 Read-only enforcement

The Kea API exposes reads and writes over the same `POST /`, and the
credential can run every command ([§3.2.5](#32-behaviours-that-shape-the-design)).
Neither the HTTP method nor the path can distinguish a read from a write, so
read-only enforcement lives in how requests are built:

- The client exposes exactly one operation, `command(name)`. `name` is typed as
  a union of the commands in [§3.1](#31-commands-used) and checked at runtime
  against a frozen allowlist before any request is built.
- **There is no parameter for `arguments`.** The request body is serialised
  from the command name alone. No caller can attach arguments, so a command
  that is read-only only without arguments cannot be turned into something
  else.
- The request path is the fixed string `/` appended to the target's base URL.
  Redirects are never followed and `Location` is never read.

N1 is satisfied structurally: no code path can construct a request for a
mutating command. A test asserts that every `write`-classified command in
Kea's API definitions is rejected before a socket is opened.

### 6.4 Least privilege

Kea cannot give the exporter a read-only credential
([§3.2.5](#32-behaviours-that-shape-the-design)). The exporter's own
enforcement ([§6.3](#63-read-only-enforcement)) protects against the exporter
misbehaving. It does nothing if the credential is stolen. The install guides
therefore treat the credential as administrative and recommend these controls,
strongest first:

1. **A dedicated control socket for the exporter**, bound to a management
   address rather than a client-facing one, with its own `authentication`
   block containing only the exporter's user. Kea supports several
   `control-sockets` per daemon.
2. **Network restriction** so that only the exporter can reach that socket: a
   host firewall, or a Kubernetes NetworkPolicy on the Kea side.
3. **HTTPS with `cert-required: true`**, so the password alone is not
   sufficient.
4. **A distinct user name for the exporter**, so its requests are attributable
   in Kea's logs.
5. **Kea-side credential files** (`user-file` / `password-file`), which Kea 3.x
   requires anyway ([§3.2.6](#32-behaviours-that-shape-the-design)).
6. Where available, the **RBAC hook** with a role restricted to the
   [§3.1](#31-commands-used) commands. This is the only control that makes the
   credential itself read-only.

A command-filtering reverse proxy in front of the control socket is a valid
alternative to item 6. It is documented as an option, not shipped.

The exporter never needs or calls any command that reveals configuration
content or secrets.

### 6.5 Redaction

- Credentials are held in a `Secret` wrapper whose `toString`, `toJSON` and
  `util.inspect` all return a placeholder, so N5 holds even on a log or error
  path nobody anticipated.
- The `Authorization` header is built at request time and never stored on any
  object that is logged.
- **No request or response header is ever logged**, at any level. That is
  stricter than logging an allowlist, and leaves nothing to keep in sync.
- Log fields are redacted at the logger boundary: any value under a key
  ending in `password`, `secret`, `token`, `authorization`, `cookie` or
  `credential` is replaced, and so is any `Secret` wherever it appears.
- Errors are normalised before logging, to message, poll-error reason and the
  messages along the `cause` chain. Properties attached to an error are never
  serialised wholesale.
- A URL containing userinfo (`https://user:pass@host`) is rejected at
  validation, so a credential cannot reach the logs through the URL.
- Response bodies are never logged, at any level.

---

## 7. Dashboard and alerting

### 7.1 Dashboard

The shipped dashboard is generated by `scripts/generate-dashboard.ts` rather
than hand-edited. Its row layout follows the vendor's Kea dashboards, so
operators who know those find the same information in the same place. It is
written from scratch and contains no material copied from them. Panels that
depend on the Stork server's own metrics have no counterpart here.

Rows, in order:

1. **Exporter health.** `up`, `kea_up`, collector success, cache age, poll
   errors. First, because a dashboard that looks green while the exporter is
   dead is the worst possible outcome.
2. **High availability.** One row per relationship: each server's state, scopes
   served, communication-interrupted, unacked-clients-left, clock skew, and the
   partner's last state as each side sees it.
3. **Instance overview.** Version, uptime, last reload, service enabled,
   socket status, multi-threading and queue depth.
4. **DHCPv4 packets.** Received and sent rates by type.
5. **DHCPv4 drops.** Drop rate by reason.
6. **DHCPv4 subnets and pools.** Utilisation table (assigned ÷ total), declines,
   allocation failures by cause.
7. **DHCPv6 packets and drops.**
8. **DHCPv6 subnets and pools.** NA and PD utilisation.
9. **DHCP-DDNS.** NCR and update outcome rates.

Template variables: `${DS_PROMETHEUS}`, `job`, `instance`, `relationship`,
`subnet_id`. Rows for a family the operator does not run (DHCPv6, DDNS) carry
an "expected empty" description rather than looking broken.

Queries use `max by` rather than `sum by` for identity-like series, and include
`job` and `instance` in every `on()` and `group_left` match list. If two
exporters scrape the same daemon during a migration, `sum` fabricates values
and an under-specified match fails with a many-to-many error.

### 7.2 Alert rules

Shipped rules come with `promtool` unit tests asserting that every rule **both
fires and does not fire**. A one-directional test passes just as well against a
rule that fires unconditionally.

| Alert | Expression shape | Severity |
|---|---|---|
| `KeaExporterAbsent` | `up{job="kea"} == 0`. The only rule that can fire when the exporter process is gone | critical |
| `KeaDown` | `kea_up == 0` | critical |
| `KeaCollectorFailing` | `kea_collector_success == 0` | warning |
| `KeaHATerminated` | `kea_ha_state{state="terminated"} == 1` | critical |
| `KeaHAPartnerDown` | `kea_ha_state{state="partner-down"} == 1` | critical |
| `KeaHASplitBrain` | More than one server in a relationship in `partner-down`, counting only targets that are up, deduplicated by server | critical |
| `KeaHANoActiveServer` | No up target in a relationship serving a scope: `max by (relationship) (kea_ha_scopes_served and on (job, instance) kea_up == 1) == 0`. A down target counts as serving nothing, whatever its frozen series say | critical |
| `KeaHACommunicationInterrupted` | `kea_ha_communication_interrupted == 1` | warning |
| `KeaHAFailoverImminent` | `kea_ha_communication_interrupted == 1 and kea_ha_unacked_clients_left <= 2` | critical |
| `KeaHANotOperational` | `kea_ha_state{state=~"waiting\|syncing\|ready"} == 1` for 15 m | warning |
| `KeaHAMaintenance` | `kea_ha_state{state=~"in-maintenance\|partner-in-maintenance"} == 1` for 1 h | info |
| `KeaHAClockSkew` | `abs(kea_ha_clock_skew_seconds) > 30`. Kea terminates HA at 60 | warning |
| `KeaServiceDisabled` | `kea_service_globally_disabled == 1` for 5 m, `unless` the same target's HA state is `in-maintenance`. A server in deliberate maintenance holds its service disabled for the whole window, observed live | warning |
| `KeaControlSocketNotReady` | `kea_control_socket_status{status!="ready"} == 1` | warning |
| `KeaPoolNearExhaustion` | `kea_dhcp4_pool_addresses_assigned / kea_dhcp4_pool_addresses > 0.9`, and the v6 NA/PD equivalents | warning |
| `KeaAllocationFailures` | `rate(kea_dhcp4_allocation_failures_total[5m]) > 0`, and v6. The global counter, because per-subnet failure statistics appear only after a subnet's first failure ([§3.2.14](#32-behaviours-that-shape-the-design)) | warning |
| `KeaPacketDropRateHigh` | Drops for `queue-full`, `processing-failed` or `parse-failed`, over 1% of received traffic, with at least one packet per second received. `not-for-us` (normal in HA), `admin-filtered` (intentional) and `duplicate` (routine) are excluded | warning |
| `KeaDdnsUpdateFailures` | `rate(kea_d2_updates_failed_total[5m]) + rate(kea_d2_updates_timed_out_total[5m]) > 0` | warning |
| `KeaDaemonMismatch` | `kea_daemon_mismatch == 1` | warning |
| `KeaVersionUnsupported` | `kea_server_version_supported == 0` | warning |
| `KeaStaleData` | `kea_exporter_cache_age_seconds` above a multiple of the poll interval | warning |
| `KeaCardinalityGrowth` | `kea_exporter_series` above a documented ceiling, or `kea_exporter_subnets_truncated > 0` | warning |

`KeaHASplitBrain` deduplicates by server before counting, so two exporters
scraping one daemon during a migration cannot report one server twice.

`KeaHAPartnerDown` and `KeaHASplitBrain` deliberately overlap. One server in
`partner-down` is a degraded but working pair. Two is an incident.

A test cross-checks every metric name referenced by the dashboard and by the
rules against the exporter's actual declarations, so a rename cannot silently
leave either querying a series that no longer exists.

---

## 8. Deployment

Three supported paths, each with an install guide ending in the same
verification steps.

- **Standalone.** A Node process, plus a systemd unit using `DynamicUser`,
  `ProtectSystem=strict`, `NoNewPrivileges`, `LoadCredential=` for the password
  file, and an `EnvironmentFile` at mode `0600`.
- **Docker.** A multi-arch image (`linux/amd64`, `linux/arm64`); compose file
  with `read_only`, `cap_drop: ALL` and `no-new-privileges`, and the password
  mounted as a Docker secret.
- **Kubernetes.** Deployment (single replica, `Recreate` strategy,
  `automountServiceAccountToken: false`, `runAsNonRoot`,
  `readOnlyRootFilesystem`, `seccompProfile: RuntimeDefault`, all capabilities
  dropped, `/healthz` liveness and `/readyz` readiness), Service, ConfigMap,
  example Secret, and a NetworkPolicy restricting egress to the Kea
  control-socket ports and ingress to the scraper.

Kea daemons commonly run with host networking, outside the cluster, or both.
The exporter reaches them over plain TCP like any other client and needs no
host networking or privilege itself.

Kubernetes scrape integration is documented **both** ways: a plain
`scrape_configs` snippet, and an optional Prometheus Operator `ServiceMonitor`.
The plain snippet comes first and the `ServiceMonitor` is explicitly marked
optional, because a cluster running Prometheus without the Operator has no such
CRD and applying that manifest there fails.

Each install guide includes the Kea side of the setup:

- A dedicated `control-sockets` entry with HTTPS and `password-file`
  authentication.
- The recommendation to set the daemon's default statistics sample count to 1
  ([§3.2.11](#32-behaviours-that-shape-the-design)).
- The least-privilege controls from [§6.4](#64-least-privilege).

---

## 9. Open questions

Each is resolved during live validation (Phase 15) and this section is updated
with the finding. Validation against a Kea 3.2.1 hot-standby pair settled some
of them, as noted below; [LIVE_VALIDATION.md](LIVE_VALIDATION.md) has the
full record. That pass confirmed:

- the `status-get` and HA field sets in [§3.2.15](#32-behaviours-that-shape-the-design)
  on both sides of a pair;
- that both servers report the same `relationship` key;
- that `reload` equals `uptime` on a daemon never reloaded;
- that a daemon without `subnet_cmds` answers `subnet4-list` with result 2;
- that every live DHCPv4 statistic maps to a declared metric.

1. **Port registration.** 10167 was checked unallocated against the
   Prometheus default-port allocation registry in Phase 0. Adding this
   exporter's entry to that registry is an edit outside this repository. The
   release checklist gates the first tag on it, and the port is re-checked
   then, since changing it after v0.1.0 breaks every deployed manifest.
2. **`remote.age` and `remote.in-touch` semantics.** Believed to be seconds
   since the last successful partner contact and "has ever reached the partner"
   respectively. **Resolved:** `age` is seconds since the partner was last
   heard from. It rose steadily through an outage and fell back on
   recovery. `in-touch` stayed `true` through the outage, so it means "has
   been in contact since startup", not "in contact now". The HELP text says
   so ([LIVE_VALIDATION.md](LIVE_VALIDATION.md)).
3. **Whether `unavailable` appears in `local.state` or only in
   `remote.last-state`.** **Resolved:** it appears as the partner's last
   state while the partner is unreachable. It was never observed as a
   server's own state.
4. **`status-get` output for hub-and-spoke and passive-backup.** Confirm that
   a hub reports one `high-availability[]` entry per relationship, and whether
   a passive-backup server reports a `remote` block at all.
5. **DHCP-DDNS statistic names** ([§5.7](#57-dhcp-ddns)), including the
   per-key form.
6. **`version-get` response shape.** **Resolved:** Kea 3.2.1 returns the
   version in `text` and a multi-line build report in `arguments.extended`,
   which begins with the same version. The parser reads `text` first and
   keeps the `extended` fallback.
7. **Per-subnet non-cumulative counters across a reload.** `v4-allocation-fail*`,
   `v4-lease-reuses` and `v4-reservation-conflicts` are not in the documented
   list of statistics removed on reload. Confirm whether they reset, persist
   or are recreated at zero. The per-subnet `v4-allocation-fail*` entries are
   created lazily ([§3.2.14](#32-behaviours-that-shape-the-design)), so this
   needs a subnet that has had a failure. **Partly resolved:** across a real
   configuration reload on Kea 3.2.1:
   - per-subnet `cumulative-assigned-addresses` reset to zero, as
     [§3.2.9](#32-behaviours-that-shape-the-design) expects;
   - the global `cumulative-assigned-addresses` and `v4-lease-reuses` kept
     counting;
   - per-subnet `v4-lease-reuses` and `v4-reservation-conflicts` also
     persisted rather than resetting.

   Allocation failures are still unconfirmed.
8. **Whether `parse-failed` is counted in `receive-drop`.** Affects whether a
   dashboard can show "other drops" as a remainder.
9. **`status-get` field set on the DDNS daemon.** Confirm which
   [§5.1](#51-per-target-health) fields it carries.

---

## 10. Stability commitment

Semver applies to the exporter's public surface: metric names, label names,
label value sets of state-set metrics, and environment variable names. Log
fields are not a contract.

- **Major:** renaming or removing a metric, label or variable; changing a
  default that changes existing series' label sets (such as
  `ENABLE_SUBNET_LABELS`); raising the Node.js floor.
- **Minor:** new metrics, new optional variables, new values in a state set
  when Kea adds one. Adding a label to an existing metric is a minor change
  recorded under `Changed`.
- **Patch:** fixes.

Metric names are this exporter's own, not Kea's. When Kea renames a statistic,
the mapping in [§5](#5-metric-surface) absorbs it in a patch release, rather
than becoming a breaking change for every downstream dashboard and alert rule.
