# Live validation

Phase 15 of [IMPLEMENTATION.md](IMPLEMENTATION.md): the exporter run against
real Kea servers rather than fixtures. This records what was exercised, what
it confirmed, what it changed, and what remains unexercised.

## Environment

A two-server Kea 3.2.1 DHCPv4 pair in `hot-standby` mode. Each server has its
own per-daemon control socket with basic authentication, and neither loads
`subnet_cmds`. No DHCPv6 or DHCP-DDNS daemon was available.

## Method

- **Read-only captures.** Every allowlisted command was captured raw from
  both servers. The captures stayed in a gitignored working directory and are
  not in this repository: even sanitised, they would publish a real
  deployment's subnet IDs, pool layout, lease counts and traffic volumes. The
  fixtures in `test/fixtures/` stay hand-authored and were reconciled with
  every shape difference the captures showed (see "Fixture reconciliation").
- **Exporter run.** The built exporter ran against both servers, polling every
  5 seconds, with a scraper recording every change in the HA, health and
  counter series.
- **Disruptive steps.** The operator stopped and started daemons and switched
  maintenance mode with Kea's own tooling. The exporter only observed, as it
  can only ever send read commands.
- **Credential check.** A deliberately wrong password was sent once.

## Results

### Steady state

| Check | Result |
|---|---|
| Every collector succeeds on both servers | Confirmed |
| Every live DHCPv4 statistic maps to a declared metric (no unknown statistics, no parse errors) | Confirmed |
| Both servers report the same `relationship` key | Confirmed, so cross-server rules join |
| `version-get` shape (D§9.6) | Version in `text`; build report in `arguments.extended` |
| A daemon never reloaded reports `reload` equal to `uptime` | Confirmed |
| `subnet4-list` without `subnet_cmds` | Result 2; `kea_command_supported{command="subnet4-list"} 0` |
| Wrong password | HTTP 401 with a bare `{"result": 401}` object; `kea_up 0`, reason `auth` |
| Statistic sample histories | Between 1 and 20 samples per statistic; the newest is read |
| `--dump-raw` | Every command answered; the sanitised dump passed the fixture guard and contained none of the real addresses or names |

### Configuration reload

Observed across an operator reload of one server:

- **Reset to zero:** per-subnet `cumulative-assigned-addresses`. They are
  exported as counters, so Prometheus reads this as an ordinary counter reset.
- **Kept counting:**
  - global `cumulative-assigned-addresses` and `v4-lease-reuses`;
  - per-subnet `v4-lease-reuses` and `v4-reservation-conflicts`.

Per-subnet `v4-allocation-fail*` statistics did not exist on either server.
Kea creates them only on a subnet's first failure.

### Standby stopped and restarted

1. With the standby stopped, the primary moved to `partner-down`, with
   `communication-interrupted` set. The partner's last state read
   `unavailable`.
2. `age` rose steadily: it is seconds since the partner was last heard from.
   `in-touch` stayed `1` throughout, so it means "has been in contact since
   startup", not "in contact now".
3. On restart, the standby went `waiting` → `ready` → `hot-standby`. It held
   its DHCP service disabled (origin `local-command`) while it synchronised.
4. The primary returned to `hot-standby` within 15 seconds of the standby
   coming up.

### Maintenance mode

`ha-maintenance-start` sent to the standby moved it to `in-maintenance`, with
its service disabled, and the primary to `partner-in-maintenance`, while the
primary kept serving. Both moved in the same poll. `ha-maintenance-cancel`
returned both to `hot-standby` in the same poll.

### Primary stopped

1. The standby set `communication-interrupted`. It then counted connecting
   and unanswered clients toward its takeover threshold, while traffic was too
   light to reach it.
2. The operator then reloaded the standby with `max-unacked-clients: 0`. The
   reload took it to `waiting`, with service disabled, and it moved to
   `partner-down` and served once `max-response-delay` had elapsed.
3. When the primary came back, it went through `ready`, and both returned to
   `hot-standby`.
4. The unanswered-client gauges reset to zero when communication was
   restored, as D§5.2 describes.

Two operational points follow:

- **Takeover depends on client traffic.** With a non-zero
  `max-unacked-clients`, a standby takes over only once that many distinct
  clients go unanswered. On a quiet network that can take far longer than an
  outage lasts.
- **With `max-unacked-clients: 0`, `KeaHAFailoverImminent` fires on every
  interruption.** Takeover then follows `max-response-delay` alone, and
  `unacked-clients-left` stays near zero for the whole interruption. The
  alert then duplicates `KeaHACommunicationInterrupted`.

## Defects found and fixed

| Found | Effect | Fix |
|---|---|---|
| With the partner unreachable, Kea reports `clock-skew` and `system-time` as `null` | The HA parser rejected the section, so every HA series stayed frozen at its last healthy value through a real `partner-down` | `null` is absent, in the HA and status parsers. Fixture `ha/hot-standby-partner-unreachable.json` |
| A server that has not yet reached its partner reports `last-state` as an empty or null value | The first poll after a restart failed the HA collector | An unlearned partner state renders no partner-state series. Fixture `ha/hot-standby-standby-starting.json` |
| Start and reload timestamps, derived from whole-second uptimes, wobbled by a second between polls | `changes()` over the reload timestamp would count the wobble as reloads | A newly derived value within two seconds of the last one keeps the last value |
| A server in maintenance holds its service disabled for the whole window | `KeaServiceDisabled` would fire five minutes into any planned maintenance | The rule excludes a target whose HA state is `in-maintenance` |
| A down target keeps its last series values (D§5.8) | `KeaHANoActiveServer` would not fire while a dead primary's frozen `scopes_served` read 1 and the standby served nothing; a server that died in `partner-down` could raise a false `KeaHASplitBrain` | Both cross-server rules count only targets with `kea_up == 1` |
| A wrong password draws HTTP 401 with `{"result": 401}`, not the assumed 403 | None: the classifier already handled both | Fixture `envelope/auth-unauthorized.json` |

Each fix has unit or `promtool` tests built from the observed shape.

## Fixture reconciliation

- The matched hot-standby pair fixtures now mirror the observed top-level
  field sets. They drop `extended-info-tables`, which the servers did not
  send, and carry an extra lease-file field the parser must ignore.
- The partner-unreachable, server-starting and 401 fixtures above were added
  from observed shapes.
- Values, names and addresses in every fixture remain placeholders.

## Alerts observed against real transitions

| Alert | Live behaviour |
|---|---|
| `KeaDown` | Condition held for the stopped server |
| `KeaHACommunicationInterrupted` | Condition held during both outages |
| `KeaHAPartnerDown` | Condition held on the surviving server |
| `KeaHANotOperational` | Condition held briefly during resynchronisation. It cleared well inside the 15-minute window, so it correctly did not fire |
| `KeaServiceDisabled` | Brief during resynchronisation, so it correctly did not fire. Would have fired during maintenance, which led to the fix above |
| `KeaHANoActiveServer` | Would not have fired before the fix above; fires after it |
| `KeaHAFailoverImminent` | `unacked-clients-left` did not reach the threshold at the traffic observed |

Every alert in `alerts/kea.yaml` also has `promtool` tests in both directions.

## Not exercised

- DHCPv6 and DHCP-DDNS daemons. Their statistic names rest on the Kea
  documentation and hand-authored fixtures (D§9.5, D§9.9).
- `load-balancing`, `passive-backup` and hub-and-spoke topologies (D§9.4).
- HTTPS control sockets and client certificates against Kea. The TLS paths
  are covered by tests against local HTTPS servers only.
- `subnet_cmds` loaded, so subnet labels with real prefixes.
- Per-subnet allocation failures across a reload, which needs a subnet that
  has had a failure (D§9.7).
- Whether `parse-failed` is counted in `receive-drop` (D§9.8). No drops
  occurred.
