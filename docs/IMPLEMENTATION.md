# Implementation Plan

How the exporter gets built: repository layout, shared primitives, and phased
delivery with exit criteria. This is a working document for contributors and is
retired at v1.0.0.

For what the exporter is and why each decision was made, see
[DESIGN.md](DESIGN.md). Section references of the form `D§3.2` point there.
Where the two documents disagree, DESIGN.md is authoritative and this plan is
wrong.

Every phase ends green on:

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run check
```

Phases are ordered so that the riskiest unknowns are settled first: the
array-or-object response envelope, result-code handling, and the shape of the
HA section of `status-get`. The core deliverable, HA state, lands before the
statistics tier, which mirrors data other tools already expose.

---

## Repository layout

The target state once every phase below is complete. Most of it does not
exist yet; each phase section says what it adds.

```
LICENSE  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
CHANGELOG.md  package.json  tsconfig.json  tsconfig.test.json  biome.json
example.env

src/
  index.ts                    startup sequence
  cli.ts                      --version / --help / --dump-raw
  version.ts
  node-version-check.ts
  lifecycle.ts
  config/
    types.ts  load.ts  validate.ts  secret.ts  redact-summary.ts  deep-freeze.ts
  http/
    agent.ts  client.ts  command-allowlist.ts  retry.ts  errors.ts  clock.ts
  log/
    logger.ts  redact.ts
  api/
    envelope.ts  stat-name.ts  stat-sample.ts
    version.ts  status.ts  ha.ts  statistics.ts  subnets.ts  config-hash.ts
  domain/
    status.ts  ha.ts  subnet-map.ts
  metrics/
    registry.ts  state-set.ts  absent-gauge.ts  upstream-family.ts
    status-metrics.ts    status-collector.ts
    ha-metrics.ts        ha-collector.ts
    stat-map.ts          (statistic name → metric family; one table per daemon)
    statistics-collector.ts
  poller/
    target-registry.ts  target-poller.ts  cache.ts  refresh-cache.ts  self-metrics.ts
  server/
    server.ts  routes.ts
  dump-raw.ts
  sanitize.ts                 leak detector and sanitiser, shared with scripts/
  healthcheck.ts

test/
  unit/  integration/  support/
  fixtures/{envelope,version,status,ha,statistics,subnets,golden}/

alerts/       kea.yaml  kea.test.yaml
dashboards/   kea.json
Dockerfile
deploy/       docker-compose.yml  kubernetes/  systemd/
docs/         DESIGN.md  IMPLEMENTATION.md  METRICS.md
              INSTALL_STANDALONE.md  INSTALL_DOCKER.md  INSTALL_KUBERNETES.md
              KEA_SETUP.md  DASHBOARDS_AND_ALERTS.md  TROUBLESHOOTING.md
              LIVE_VALIDATION.md  RELEASE_CHECKLIST.md
scripts/      generate-metrics-doc.ts  generate-dashboard.ts  sanitize-fixtures.ts
              check-pack-allowlist.ts  check-no-native-addons.ts
              check-license-compound.ts  check-dco.ts
              fetch-promtool.ts  fetch-gitleaks.ts  verified-download.ts
              extract-changelog-section.ts
.github/workflows/  ci.yml  release.yml  rebuild.yml  scan.yml
```

---

## Shared primitives

Built in the early phases and consumed everywhere after. Each is small, pure
where possible, and independently testable.

### `config/secret.ts`

A `Secret` wrapper whose `toString`, `toJSON` and `util.inspect` custom hook all
return a redaction placeholder. N5 then holds even on a log or error path nobody
anticipated, instead of depending on every call site remembering to redact.
`reveal()` is the only accessor, and it is called in exactly one place: the
function that builds the `Authorization` header.

### `http/clock.ts`

An injectable clock: `now()`, a monotonic `elapsed()`, and `sleep()`. Every
timing behaviour is then deterministically testable, and no test sleeps in real
time.

### `http/command-allowlist.ts`

The frozen set of commands from D§3.1, exported both as a TypeScript union type
and as a runtime `ReadonlySet`. The type makes a wrong command a compile error;
the set makes it a runtime error for any path the type system does not reach.
This is the mechanism behind D§6.3. It replaces a path allowlist because the
Kea API has a single path for every command.

### `http/client.ts`

A client with one operation, `command(name: AllowedCommand)`, that:

- serialises `{"command": name}` and nothing else, since no `arguments`
  parameter exists;
- POSTs to the target's base URL with the fixed path `/`, `Content-Type:
  application/json`, and a basic-auth header built from the `Secret` at request
  time;
- runs within a **total wall-clock budget** per logical call, with each attempt
  given an `AbortSignal.timeout` sized to the remaining budget, and backoff time
  deducted on the monotonic clock;
- reads the body as a stream and aborts once it exceeds `MAX_RESPONSE_BYTES`
  (D§6.2), classifying the failure as `too_large`;
- never follows redirects and never reads `Location`.

It returns `{ statusCode, body }` as a string. `--dump-raw` uses that return
value directly, and there is no separate raw-response hook.

### `http/retry.ts`, `http/errors.ts`

Retries apply only to `network`, `timeout` and `http_5xx`. Up to 3 attempts,
with exponential backoff and full jitter, within the call's budget. `auth`,
`http_4xx`, `parse`, `api_error` and `too_large` are not retried. The error
taxonomy is a discriminated union whose discriminant is the D§5.9 `reason`
label value, so the label cannot drift from the classification.

### `api/envelope.ts`

One function that classifies any response, used by every call site:

| Input | Classification |
|---|---|
| HTTP 401 or 403, or a bare object with `result` 401/403 | `auth` |
| one-element array, `result` 0 | `ok` (with `arguments`) |
| one-element array, `result` 2 | `unsupported` |
| one-element array, `result` 3 | `empty` |
| one-element array, any other `result` | `api-error` (with `text`, truncated) |
| not JSON, an array of any other length, or an element without an integer `result` | `not-json` / `malformed` |

The array-or-object behaviour (D§3.2.3) and the result-code table (D§3.2.4) are
then handled in exactly one place instead of being remembered per collector.

### `api/stat-name.ts`

Parses a statistic name into `{ scope: 'global' | 'subnet' | 'pool' | 'pd-pool',
subnetId?, poolId?, stem }`. It accepts `subnet[<id>].<stem>`,
`subnet[<id>].pool[<pid>].<stem>` and `subnet[<id>].pd-pool[<pid>].<stem>`, and
rejects non-numeric or negative IDs. It also produces the templated form
(`subnet[*].pool[*].<stem>`) used as the unknown-statistic label (D§5.8).

### `api/stat-sample.ts`

Extracts the current value from a sample list (`[[value, timestamp], ...]`):
the first element's first member, which must be a finite number. The timestamp
is ignored by design (D§3.2.12). An empty list, or a non-numeric value, is a
per-statistic parse error. It does not fail the whole response.

### `metrics/state-set.ts`

Pure enum classification returning `{ kind: 'absent' | 'recognized' |
'unrecognized' }`. The caller owns the unknown-value counter, which keeps the
primitive free of metric dependencies and therefore trivially testable.

### `metrics/absent-gauge.ts`

A label-free-gauge wrapper (`set`/`clear`/`setOrClear`) that removes and
recreates the underlying gauge rather than resetting it. `reset()` alone can
only zero a label-free gauge. It can never make its single series disappear,
and D§3.2.14 requires absent-not-zero.

### `metrics/upstream-family.ts`

A metric family, counter or gauge, whose values are taken directly from
upstream and set wholesale each cycle. Counters render `TYPE counter` but are
never incremented locally. The client library's `Counter` offers only
`inc()`, so each render resets the family and re-adds the upstream value. The
Kea values are already lifetime totals, reset by Kea itself on restart or
reload (D§3.2.9), so a value lower than the previous one is accepted without
complaint. Detecting that as a reset is Prometheus's job.

A labelled family is always registered. A label-free one is registered only
while its statistic exists, so a missing statistic is absent rather than
zero.

### `poller/refresh-cache.ts`

The independent-cadence primitive:

```ts
createRefreshCache<T>({ clock, intervalMs, fetch, initialValue, onFailure })
  => { refreshIfDue(): Promise<boolean>, invalidate(): void, getCached(): T }
```

`refreshIfDue()` resolves to whether it actually attempted a fetch. A caller
can then distinguish a cycle that made a real attempt, and may count that
attempt's failure, from an off-cadence cycle restating the last outcome.
`invalidate()` forces the next `refreshIfDue()` to fetch. It is how a
configuration-hash change triggers a subnet-map refresh (D§5.6). A failed
refresh retains the previous value and does not throw. The version check uses
the same primitive, invalidated when uptime goes backwards.

### `poller/cache.ts`

An immutable `CacheEntry` with a monotonic `fetchedAt`, plus a parse-error
tracker. A cycle that returns zero results *because parsing failed* is not
recorded as a success.

### `log/*`

- `redact.ts` provides `redactFields`, applied at the logger boundary in both
  formats. It replaces any value under a key ending in a sensitive word, and
  any `Secret` wherever it appears. The match is anchored at the end of the
  key, so `kea_password` is redacted but `passwordSource`, which names only a
  variable and a path, is not.
- `redact.ts` also provides `errorFields`, which reduces an error to its
  message, poll-error reason and the messages along its `cause` chain.
- There is no header allowlist and no URL sanitiser. Nothing logs a header,
  and no logged URL can carry a credential: userinfo is rejected at
  validation and the client sends no query string.
- `console.*` is banned outside `scripts/` by lint rule.

---

## Phase 0 — Scaffold and hygiene

`package.json` (Apache-2.0, `engines.node >=24`, a `files` allowlist, `bin`),
`tsconfig.json` and `tsconfig.test.json`, `biome.json`, `.gitignore`,
`.dockerignore`, `.gitattributes`, `.gitleaks.toml`, `LICENSE`, `README.md`,
`CONTRIBUTING.md` (DCO sign-off), `CODE_OF_CONDUCT.md`, `SECURITY.md` (private
vulnerability reporting through GitHub Security Advisories, supported
versions, response expectations), `CHANGELOG.md` (Keep a Changelog), `example.env`,
issue and PR templates, `dependabot.yml`, and a placeholder `src/index.ts`
(just enough for `tsc` to have an input and for `bin` to point at a real,
shebanged file).

`.gitignore` covers `.env`, `.env.*` except `example.env`, `*.pem`, `*.key`,
`*.crt`, `*.p12`, `dist/`, `node_modules/`, raw-dump output files, `.test-tmp/`
and `scratch/`. Contributor-local reference material and live captures never
enter history. Tests that need scratch space create it under `.test-tmp/` in
the project, never in the OS temp directory.

Every `.dockerignore` pattern is `**/`-prefixed. Docker's exclusions, unlike
git's, match only at the context root, so an unprefixed `*.pem` would leave
nested key material in the build context.

Supply-chain guard scripts with their tests: `check-no-native-addons.ts`,
`check-pack-allowlist.ts` and `check-license-compound.ts`, aggregated behind
`npm run check` together with a production `npm audit`. `check-dco.ts` takes a
commit range and runs in CI only (Phase 14), since it needs history to check.
The guards are wired into `CONTRIBUTING.md` and the PR template, so they are
actually run, not just present.

**Default port.** 10167, checked unallocated against the Prometheus
default-port allocation registry and not 9547 (D§4.5, D§9.1). Every later
artefact uses it.

**Exit:** test run green; `npm pack --dry-run` contains only intended files;
the default port is chosen and recorded.

No git repository exists before Phase 14. Nothing in Phases 0–13 needs one, and
the first commit is permanent public history, so it is made only once the
whole tree has passed the sanitisation guard and a leak scan.

## Phase 1 — Fixtures and sanitisation

Hand-authored fixtures built from the schemas in D§3 and the Kea API
definitions. Phase 15 replaces them with sanitised live captures. Coverage is
chosen to hit every documented hazard:

- **Envelope:** a one-element success array; the bare `{"result":403}` object
  (D§3.2.3); result 1, 2 and 3 arrays; a two-element array; a non-JSON body.
- **`status-get` for DHCPv4:**
  - multi-threading on, and multi-threading off;
  - `dhcp-state` with each disabled origin;
  - `sockets.status` in each of its three values, with `errors` on the non-ready ones.
- **`status-get` HA variants:**
  - hot-standby primary and standby, as a matched pair (same relationship,
    opposite sides);
  - load-balancing with communication interrupted and non-zero
    connecting/unacked counts;
  - a hub with two relationships;
  - passive-backup with no `remote` block;
  - an unrecognised state value;
  - every one of the 13 states across the set.
- **`status-get` for DDNS:** the reduced field set.
- **`statistic-get-all` for DHCPv4:**
  - global, subnet, and pool statistics, with 20 samples each;
  - a statistic with a single sample;
  - a missing statistic (D§3.2.14);
  - an unknown statistic name;
  - an empty sample list.
- **`statistic-get-all` for DHCPv6:** NA pools, PD pools, registration
  statistics, and a `total-nas` of 2^64 written as an exact literal. A real
  DHCPv4 count cannot exceed 2^32, so the above-2^53 case lives here.
- **`statistic-get-all` for DDNS:** global and per-key statistics.
- **Subnet list:** `subnet4-list` and `subnet6-list` with and without shared
  networks; a result-2 response (hook absent); a result-3 response (no
  subnets).
- **Config hash:** two `config-hash-get` responses with different hashes.
- **Version:** `version-get` in both candidate shapes (D§9.6), and a 2.x
  version.

The sanitiser and the leak detector live in `src/sanitize.ts`, not under
`scripts/`, because `--dump-raw` (Phase 11) reuses them from `dist/`.
`scripts/sanitize-fixtures.ts` is the CLI around them. It rewrites one or more
raw captures into fixture form, with one mapping shared across every input
in a run, so both sides of an HA pair agree on which server is `server1`:

- Each distinct IPv4 /24 maps to one of the three RFC 5737 networks, keeping
  the host octet and any prefix length. An input with more than three /24s
  is refused, since the documentation space cannot keep them distinct.
- Each distinct IPv6 /48 maps to `2001:db8:<n>::/48` (RFC 3849), keeping the
  remaining bits and any prefix length.
- Hostnames and domains map to `hostN.example.com`.
- MAC addresses map into the RFC 7042 documentation range.
- HA server names, including scope lists, map to `server1`, `server2`, and so
  on.
- TSIG key names map to `key1`, `key2`, and so on.
- Shared-network names map to `network1`, `network2`, and so on.
- Password-like JSON values and basic-auth header values become `REDACTED`.
- Long token-like runs become `REDACTED-TOKEN-N`.
- Structural values (counters, IDs, states, booleans) are preserved. Renames
  are textual, never a JSON round-trip, so values above 2^53 stay exact.

A result that still contains a leak is not written at all.

The **sanitisation guard** (`npm run check:fixtures`, and a unit test over the
committed set) walks the fixture data under `test/fixtures/`. It skips
Markdown prose. It fails on:

- any IPv4 or IPv6 literal outside the documentation ranges, loopback,
  link-local and unspecified. That includes RFC 1918, CGNAT and ULA space.
- any domain outside `example.com`, `example.net` and `example.org`;
- any MAC address outside the RFC 7042 documentation range;
- any string shaped like a basic-auth header, a long token, or a
  password-like JSON value;
- any HA server name, scope, shared-network name or TSIG key name not in the
  placeholder form.

A second test asserts each fixture's shape matches what its parser expects, so
a mangled sanitisation pass is caught too.

**Exit:** the sanitisation guard fails on a deliberately planted bad fixture of
each kind, and passes on the committed set.

## Phase 2 — Configuration and targets

`config/types.ts` (`TargetConfig`, `AppConfig`), `load.ts` (`--env-file`, with
the process environment taking precedence), `validate.ts`, `secret.ts`,
`redact-summary.ts`, `deep-freeze.ts`.

The configuration rules, all from D§6.1:

- Target-name parsing and the `__<NAME>` override resolution for every
  per-target setting.
- The orphan-override startup error.
- Mandatory daemon resolution per target.
- Mutual exclusion of `KEA_PASSWORD` and `KEA_PASSWORD_FILE`.
- Rejection of userinfo in URLs.
- The `http:` warning.
- Client certificate and key accepted only as a pair.
- `POLL_INTERVAL_SECONDS` floor.

The password file is read once at load time into a `Secret`. A missing,
unreadable or empty file is a startup error naming the variable, never the
contents.

**Exit:** tests for every validation rule, reporting all errors at once rather
than the first; tests for duplicate and malformed target names, the orphan
override, and an unresolved daemon; and a test proving that no configuration
summary or thrown error can contain a password, whichever variable supplied it.

## Phase 3 — HTTP layer, envelope, command allowlist

`http/agent.ts`, `client.ts`, `command-allowlist.ts`, `retry.ts`, `errors.ts`,
`clock.ts`; `api/envelope.ts`, `api/stat-name.ts`, `api/stat-sample.ts`.

One `undici` Agent per target. Each Agent carries that target's CA bundle and
client certificate only, with `minVersion: 'TLSv1.2'`. `NODE_EXTRA_CA_CERTS` is
never used, so one target's private CA cannot widen another target's trust.

TLS tests run against real `node:https` servers using a committed test PKI in
`test/support/tls/`:

- two independent CAs;
- a `localhost` server certificate from each;
- a client certificate from the first CA.

The CA private keys were discarded after issuing, and the three leaf keys are
allowlisted by exact path in `.gitleaks.toml`.

**Exit:** tests prove each of the following.

- The bare 403 object classifies as `auth`.
- Results 2 and 3 classify as `unsupported` and `empty`, not as errors.
- A command outside the allowlist throws before a socket is opened. This is
  checked for every name in `test/support/kea-commands.ts`, which holds Kea
  write commands plus the read commands that expose configuration or
  per-client data (`config-get`, `lease*-get*`). The list holds names only,
  not Kea's API files.
- The request body contains exactly one key.
- A redirect is not followed and the `Authorization` header does not reach its
  target.
- An over-size body aborts with `too_large`.
- The wall-clock budget is respected across retries.
- A CA loaded for one target does not let another target trust that host.

## Phase 4 — Status collector, version, honest `up`, daemon verification

`api/version.ts`, `api/status.ts`, `domain/status.ts`,
`metrics/status-metrics.ts`, `status-collector.ts`.

- **Per-target startup preflight.** `version-get`, then `status-get`.
  - The version populates `kea_server_version_info` and
    `kea_server_version_supported` (D§3.4).
  - The version parser accepts both candidate response shapes (D§9.6).
- **`kea_up`** derives only from the actual `status-get` outcome of each cycle.
- **Restart detection.** An `uptime` lower than the previous cycle's means the
  daemon restarted. It invalidates the version cache, so an upgrade is picked
  up without restarting the exporter.
- **Daemon verification** (D§5.1) needs the statistic names of the same
  cycle, so it is built in Phase 6, not here. Until then
  `kea_daemon_mismatch` is not registered, which is the same rendering as an
  inconclusive result.
- **Shared families.** `metrics/registry.ts` creates the families every
  collector of a target writes to, `kea_collector_success` and
  `kea_exporter_unknown_enum_total`, once per target. It also provides
  `applyStateSet`, which renders a state set and counts an unrecognised
  value.
- **Derived timestamps.** Start and reload timestamps are computed from poll
  time and rounded.
- **Optional fields.** Every [D§5.1](DESIGN.md#51-per-target-health) field
  that the DDNS daemon lacks is optional at the parse boundary, so a `d2`
  target renders only what it has.

**Exit:** tests prove each of the following.

- `kea_up` is 0 for an unreachable target, 0 for a rejected credential, 0 for a
  result-1 `status-get`, and 1 only on real success (N6).
- Each `dhcp-state` origin maps to its own series.
- The socket status renders as a three-value state set.
- Multi-threading-off produces no thread-pool or queue series.
- A version below 3.0 sets supported to 0 without stopping other targets.
- An uptime decrease triggers a fresh `version-get`.

## Phase 5 — High-availability collector

The core deliverable: R1 and R2, D§5.2.

`api/ha.ts`, `domain/ha.ts`, `metrics/ha-metrics.ts`, `ha-collector.ts`. HA
data is parsed from the same `status-get` response Phase 4 already fetches. No
extra command is added.

- **`relationship` label.** Computed once, in `domain/ha.ts`: the local and
  remote server names, sorted, joined with `+`. With no `remote` block, the
  label is the local name alone.
- **State sets.** `kea_ha_state` and `kea_ha_partner_last_state` are state sets
  over the 13 states in D§3.3. An unrecognised state increments the
  unknown-enum counter and renders all 13 series as 0, never as a stale 1.
- **Scopes.** `kea_ha_scope_served` and `kea_ha_partner_last_scope` render one
  series per scope. `kea_ha_scopes_served` is the count.
- **Absent `remote` block.** Every `partner`-labelled series is absent, and
  `kea_ha_relationship_info` carries empty `partner` and `partner_role`.
- **Absent HA hook.** No `kea_ha_*` series at all, and no `ha` collector-success
  series (D§5.2).
- **Clock skew.** `clock-skew` is exported signed and as-is.

**Exit:** tests prove each of the following.

- A matched hot-standby pair fixture produces identical `relationship` values
  on both targets.
- The hub fixture produces two relationships, and removing one between renders
  drops all its series.
- Passive-backup produces no partner series.
- Each of the 13 states renders correctly.
- An unknown state increments the counter.
- An HA-absent fixture produces zero `kea_ha_*` lines.
- Golden expositions for the primary and standby of a matched pair and for an
  interrupted load-balancing relationship are committed under
  `test/fixtures/golden/`. They are produced by the status and HA collectors
  together, and regenerated only with `UPDATE_GOLDEN=1`.

The four D§5.2 worked PromQL expressions are evaluated with `promtool test
rules` in Phase 13, alongside the alert rules built from them, since that is
where `promtool` enters the toolchain.

Golden files sit under `test/fixtures/` and so pass through the sanitisation
guard. Metric HELP text therefore names Kea fields in plain words
(`Kea's in-touch field`) rather than as dotted paths, which the guard reads as
domains.

## Phase 6 — Statistics parser and DHCPv4

R3–R6 for DHCPv4. `api/statistics.ts`, `metrics/stat-map.ts`,
`metrics/upstream-family.ts`, `metrics/statistics-collector.ts`.

- **`stat-map.ts`** is the single table from Kea statistic name (scope plus
  stem) to metric family, type and fixed label values. It holds one table per
  daemon, built with a small builder that rejects a duplicate family or
  statistic. Every name in D§5.3–5.7 appears exactly once. `METRICS.md`'s
  Kea-source column and the D§5.10 mapping table are both generated from it
  in Phase 11.
- **One collector for all three daemons.** `statistics-collector.ts` is
  driven entirely by the daemon's table, so Phases 7 and 10 add table rows
  rather than collectors.
- **Counters and gauges** both render through `upstream-family`.
- **Parse errors.** `kea_exporter_parse_errors_total{group}` joins the
  shared per-target families here, because a malformed or negative sample is
  first possible in this phase. It counts one bad statistic, not a failed
  response. The status and HA collectors count their own parse failures
  under it too.
- **Missing and unknown statistics.** A missing statistic leaves its series
  absent. An unknown one increments `kea_exporter_unknown_statistic_total`
  with the templated name.
- **Cardinality cap.** `MAX_SUBNETS` applies in ascending ID order, with
  `kea_exporter_subnets_truncated`.
- **Pools.** `ENABLE_POOL_STATS=false` skips pool series entirely.
- **Daemon verification** (Phase 4's stub) is completed here.

**Exit:** tests prove each of the following.

- Every v4 statistic in the fixture maps to the documented family and type.
- The aggregate and per-type packet counters are separate families.
- The 20-sample fixture renders identically to a single-sample one.
- A missing `pkt4-inform-received` yields no series rather than 0.
- A subnet removed between renders disappears, including its pools.
- A counter value lower than the previous render is accepted.
- The truncation cap is deterministic.
- A DHCPv6 statistics fixture on a `dhcp4` target sets `kea_daemon_mismatch 1`
  and renders no `kea_dhcp4_*` families.

## Phase 7 — DHCPv6

The DHCPv6 table in `stat-map.ts`. This covers NA and PD pools, `ia_type` on
lease reuses, and the registration statistics.

**Exit:** tests show NA and PD pool series carry the right `pool_id` from
`pool[]` and `pd-pool[]` respectively, and never cross over; a
`total-nas` of 2^64 renders; the DHCPv4-over-DHCPv6 types appear under
`type`; golden files for a v6 target are committed.

## Phase 8 — Multi-target poller, per-target registries, HTTP server

`poller/target-registry.ts`, `target-poller.ts`, `render-gate.ts`,
`refresh-cache.ts`; `server/server.ts`, `routes.ts`; `log/logger.ts`,
`log/redact.ts`; `index.ts`, `cli.ts`, `lifecycle.ts`.

- **Fetch, then apply.** Every collector is split into an async `fetch()`,
  which makes network calls and writes nothing, and a synchronous `apply()`.
  A cycle runs every fetch first, then applies them all in one synchronous
  step through `RenderGate.exclusive()`, which waits out any in-flight render.
  Renders are single-flighted through the same gate. The registry's own
  awaits inside a render therefore can never interleave with an apply, and a
  scrape sees exactly one cycle. This replaces a separate snapshot cache:
  the per-target registry is the snapshot.
- **A failed `status-get` skips `statistic-get-all`.** The daemon is
  unreachable or rejecting the credential, and a second call would only
  spend the request budget. The statistics collector is marked failed and
  every series keeps its last value.
- **Cycle results.** Each cycle reports `up` and one poll-error reason per
  failed command, which Phase 11's self-metrics consume.

- **Poll loop.** Self-scheduling and driven by the injected clock, so cycles
  structurally cannot overlap. Startup jitter is per target. After a
  whole-cycle failure the loop backs off, capped, and resets on the next
  success.
- **Routes:**
  - `/metrics` (global);
  - `/metrics?target=` (per target, single-flighted so concurrent scrapes share
    one render), returning 400 for an unknown target;
  - `/healthz` (liveness, never upstream-dependent);
  - `/readyz` (503 until every target has completed one cycle, successful or
    not, then 200 and never flapping);
  - `/`;
  - 404, and 405 with an `Allow` header.
- **Server hardening:**
  - bounded `headersTimeout`, `requestTimeout`, `keepAliveTimeout`,
    `maxHeaderSize` and `maxConnections`;
  - optional TLS and mTLS on the listener;
  - a hardening snapshot logged at startup.

Startup order:

1. Node version check
2. configuration
3. logger, and redacted configuration summary
4. insecure-TLS warnings and metric
5. build info
6. **server listen**
7. poller construct, signal handlers install
8. preflight
9. poller start

The listener and the signal handlers must both precede any upstream call.
`/healthz` then answers immediately, and a `SIGTERM` arriving during a slow
preflight still runs the graceful path.

**Exit:** integration tests against the mock Kea server show each of the
following.

- Concurrent scrapes of two targets are independent.
- One target hard-down leaves the other's series intact with `kea_up 1`.
- Twenty scrapes during an upstream outage cause zero upstream requests (N2).
- A render swapped mid-scrape is never a mix of two snapshots.
- Graceful shutdown completes with no open handles.
- Bare `/metrics` returns only global series.
- An unknown target returns 400.

## Phase 9 — Subnet labels

Opt-in: D§5.6. `api/subnets.ts`, `api/config-hash.ts`, `domain/subnet-map.ts`.

- **Fetching.** When `ENABLE_SUBNET_LABELS=true`, `config-hash-get` runs every
  cycle. A changed hash invalidates the subnet-map refresh cache, and
  `subnet4-list` or `subnet6-list` refetches on that cycle.
- **Hook absent.** Result 2 sets `kea_command_supported` to 0, logs once, and
  stops calling the list command until the next hash change.
- **No subnets.** Result 3 is an empty map.
- **No shared network.** Kea sends `"shared-network-name": null`, which parses
  to an empty `sharedNetwork`, as does an absent key.
- **Rendering.** The `prefix` and `shared_network` labels are added at render
  time from the cached map.
- **Flag off.** Neither command is ever sent.

**Exit:** tests show labels appear only with the flag on; a hash change
relabels a renumbered subnet on the next cycle; a hook-absent fixture renders
unlabelled series and makes one list call, not one per cycle; with the flag off,
the mock server records zero `config-hash-get` or `subnet*-list` requests.

## Phase 10 — DHCP-DDNS

The DDNS table in `stat-map.ts`. Per-key series appear behind
`ENABLE_D2_KEY_STATS`. The key name is the
`key[<name>]` index, sanitised to the placeholder form in fixtures.

**Exit:** tests show a `d2` target renders only `kea_d2_*`, status and
self-metrics families; per-key series appear only with the flag on; a key
removed between renders disappears.

## Phase 11 — Self-observability, `--dump-raw`, generated metrics doc

- **Self-metrics.** `poller/self-metrics.ts`, with the full D§5.9 set and the
  `_series` cardinality tripwire.
- **`dump-raw.ts`.** Runs each allowlisted command once per target and writes
  JSON to stdout. All logging is diverted to stderr. The output passes through
  the same sanitiser as Phase 1 by default. `--no-sanitize` is available for a
  contributor's own local debugging, prints a warning, and is never mentioned
  in issue templates. No credential can appear, because the client never puts
  one in a response.
  - Base URLs are not included.
  - Each valid JSON body is spliced in verbatim rather than re-serialised,
    so values above 2^53 survive.
  - The sanitiser runs with `ipv4Overflow: "redact"`: a real server with more
    than three /24s still produces a dump, with the excess addresses
    replaced. The fixture CLI keeps refusing that case.
- **`scripts/generate-metrics-doc.ts`.** Produces `docs/METRICS.md` from the
  live declarations and `stat-map.ts`. That includes the Kea-source column and
  the Stork-name mapping table (D§5.10), with a drift test.
  - It finds every family by driving one real `Target` per daemon through a
    cycle against the fixtures, with every opt-in flag on. Families that only
    register once they have a value are therefore included.
  - The Stork mapping is curated data in `scripts/stork-mapping.ts`. The
    generator fails if any mapped name is not a declared metric.
  - It lists names that exist in both exporters with a different meaning or
    label set. A query copied from a Stork dashboard keeps parsing but
    silently returns something else.

**Exit:** a test proves `--dump-raw` output contains no password, no
`Authorization` value, and no address outside the documentation ranges when
run against a mock serving unsanitised data; the `METRICS.md` drift test is
green; a registry-wide test asserts every family ending `_total` is
`TYPE counter` and no other family is.

## Phase 12 — Deployment artefacts

**Dockerfile:**

- a multi-stage build from a builder image to a slim runtime, with production
  dependencies only;
- fixed non-root UID/GID `10001`, OCI labels, `EXPOSE 10167`;
- exec-form `ENTRYPOINT`, so the process is PID 1 and receives `SIGTERM`
  directly;
- a `HEALTHCHECK` (`src/healthcheck.ts`) that honours the port and TLS settings
  and **sets its own request timeout**. Docker's `--timeout` marks a check
  failed but does not reap it, leaking one process per check against a hung
  server.

`deploy/docker-compose.yml`, `deploy/kubernetes/*`, `deploy/systemd/*`, the
three install guides, and `docs/KEA_SETUP.md`, all as specified in D§8. The
Kea setup guide covers the following:

- a dedicated exporter control socket with HTTPS and `password-file`;
- generating the password file;
- the client-certificate option;
- the default sample count;
- a NetworkPolicy and host-firewall example on the Kea side;
- the D§6.4 controls in order.

Every example uses documentation addresses and `example.com` names.

**Exit:** a multi-arch build is green. An image-hygiene test builds with a
sentinel string planted in a local `.env` and a sentinel key file, then greps
every layer of the saved image for zero hits. A real container reaches
`/readyz` 200 against the mock server.

The two container suites (`test/integration/deploy/`) skip when no Docker
daemon answers, and CI runs them.

- **Image hygiene** plants sentinels named after `.dockerignore` patterns:
  `.env.*`, `*.pem`, `kea-password*` and `scratch/`. It removes them however
  the build ends.
- **Container test** also sends a real SIGTERM through `docker stop`. That
  proves the graceful-shutdown path exits 0, logs completion, and needs no
  SIGKILL. A Windows development host cannot deliver that signal to Node.

Password-file permissions differ by path:

- **Kubernetes:** the Secret volume is mounted with `fsGroup: 10001` and
  mode `0440`, because Secret files are root-owned.
- **Compose:** the install guide has the file `chown`ed to UID 10001, because
  file-based secrets keep the host file's ownership.
- **systemd:** the file is passed with `LoadCredential=`, so it can stay
  root-only.

Images are published as `ghcr.io/apilbeam101/kea-metrics-exporter`.

## Phase 13 — Dashboard and alerts

`scripts/generate-dashboard.ts` produces `dashboards/kea.json` with the row
order in D§7.1. `alerts/kea.yaml` has `kea.test.yaml` covering every rule in
D§7.2 in both directions. HA rules use a matched pair of synthetic series
sharing one `relationship`. The same test file also evaluates the four worked
PromQL expressions in D§5.2 as recording rules, so the queries quoted in the
design are themselves tested (deferred here from Phase 5).

Tests:

- **Metric-name cross-check.** Every metric referenced by the dashboard and by
  the rules exists in the declarations.
- **Multi-exporter guard.** No `sum by` over identity-like series, and every
  `on()` / `group_left` includes `job` and `instance`.
- **Layout check.** The dashboard's grid has no overlaps.

`promtool` is fetched here rather than in Phase 14, by
`scripts/fetch-promtool.ts`. The release is pinned and sha256-verified per
platform, and lands in the gitignored `.local/bin/`. This phase cannot meet its
exit bar without it. `npm run check:alerts` runs `promtool` over the rules and
the design queries.

The unit tests also check the following:

- **Dashboard queries parse.** When `promtool` is present, every dashboard
  query is written out as a recording rule with the Grafana variables
  expanded, and `promtool` parses it. A malformed query fails a test rather
  than a dashboard import.
- **Every rule is tested both ways.** Each alert in `kea.yaml` must appear in
  `kea.test.yaml` both firing and not firing.
- **Rules and dashboard are deduplicated.** The split-brain rule and the
  dashboard's HA panels aggregate with `max by` first, and `sum` may wrap only
  `rate()` or `increase()`.

**Exit:** `promtool check rules` and `promtool test rules` green in CI; every
rule observed both firing and not firing; `KeaHASplitBrain` fires on two
`partner-down` servers in one relationship and stays silent on one, and on two
in different relationships.

## Phase 14 — CI, release, supply chain

**Repository creation comes first.** This is the first phase that needs git.
Before `git init`:

1. Run the fixture sanitisation guard and a leak scan over the whole working
   tree.
2. Confirm that `git status --ignored` lists `scratch/`, `.env*`, key material
   and raw dumps as ignored.
3. Run gitleaks against the working tree with `--no-git`.

Only then make the first, signed-off commit. Every later scan runs over full
history, so anything in that first commit is permanent.

As done, the gitleaks scan ran on the staged content
(`gitleaks git --pre-commit --staged --redact`), which is exactly what the
first commit holds. A real-value scan also ran over every staged file. It
drew its terms from the gitignored live captures and printed none of them.
Phases 0–13 went in as one signed-off "Initial import" commit and were
pushed before any workflow existed. The workflows below arrive in the
following commit.

`ci.yml`:

- fast leg: typecheck, lint, unit tests;
- matrix: Linux, macOS and Windows across Node 24 and current, running build
  **and** typecheck **and** the full suite, so a platform-specific type error
  is caught and the `dist` smoke tests actually run;
- multi-arch Docker build without push, plus image hygiene;
- `npm audit --omit=dev --audit-level=high`;
- production-dependency licence allowlist with a compound-SPDX backstop;
- no-native-addons check;
- DCO check;
- gitleaks over full history;
- promtool;
- the fixture sanitisation guard.

No CI job ever holds credentials for a real Kea server. A public repository's
CI secrets are reachable from fork pull requests. Live validation is manual
(Phase 15).

`release.yml`, triggered on `v*.*.*`:

- re-verify at the tagged commit, and assert the tag matches `package.json`;
- build and push multi-arch to GHCR under `ghcr.io/apilbeam101/kea-metrics-exporter`,
  with build provenance and an attested SPDX SBOM;
- mirror the built manifest to Docker Hub with `docker buildx imagetools
  create`, under `continue-on-error: true`, so a mirror outage cannot fail a
  release;
- optionally `npm publish --provenance`, behind a repository variable;
- create a GitHub Release whose notes come from the matching `CHANGELOG.md`
  section, failing if no such section exists.

`rebuild.yml` rebuilds the base image monthly and republishes only the moving
`:latest` tag. Exact-version tags are never overwritten: the shared
`_publish-image.yml` takes a `tag-version` input, which the rebuild sets to
`false` for both GHCR and the Docker Hub mirror. `scan.yml` runs a monthly
vulnerability scan to SARIF. All actions are SHA-pinned. `promtool` and
`gitleaks` are fetched from their official releases and verified by sha256.

[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) holds every release step a
workflow cannot check, plus the one-time repository settings.

The first tag is deferred until Phase 15 completes. A correct release pipeline
and an exporter validated against real Kea servers are different claims, and
v0.1.0 should mean both. This phase's own exit bar is the dry run below, on a
fork.

**Exit:** a dry-run tag on a fork produces the following.

- An attested multi-arch image on GHCR, with build provenance for the manifest
  and a per-architecture SPDX SBOM, each verifiable with
  `gh attestation verify`.
- A mirror on Docker Hub. It carries no GitHub-native attestations, because
  `imagetools create` does not copy referrer manifests.
- A release with real notes.

## Phase 15 — Live validation and fixture reconciliation

Against real Kea 3.2 servers: an HA pair of DHCPv4 daemons, at least one
DHCPv6 daemon, and a DHCP-DDNS daemon. Capture `--dump-raw` from each and
reconcile every difference. The metric shape must be driven by real payloads,
not by the field lists in this plan.

As done, the fixtures were **not** replaced with sanitised captures. The
sanitiser leaves numbers alone, so a capture would still publish the
deployment's subnet IDs, pool layout, lease counts and traffic volumes.
Instead:

- each live shape difference was folded into a hand-authored fixture with
  placeholder values;
- the real captures stayed outside the repository;
- a local test ran the exporter against those captures.

The record is in [LIVE_VALIDATION.md](LIVE_VALIDATION.md), including which
scenarios the available servers could not produce.

HA scenarios, each recorded with its observed metric values:

1. **Normal operation.** Both servers in their operational state;
   `KeaHANoActiveServer` silent.
2. **Partner stopped.** Stop one daemon. Observe the following, and confirm
   `KeaHAFailoverImminent` fires before `KeaHAPartnerDown`:
   - `communication-interrupted`;
   - the rising `unacked_clients` and falling `unacked_clients_left`;
   - the transition to `partner-down`.
3. **Partner restarted.** Observe `waiting` → `syncing` → `ready` → operational
   on the restarted server, and confirm `KeaHANotOperational` would fire if
   the sequence stalled.
4. **Maintenance.** `ha-maintenance-start` is issued by the operator from
   Kea's own tooling, never by the exporter. Observe `in-maintenance` and
   `partner-in-maintenance`.
5. **Communication restored.** Confirm the failover gauges reset, and resolve
   D§9.2 (`age`, `in-touch`).

Other scenarios:

- **Configuration reload.** Reload the configuration and confirm per-subnet
  counters reset while global counters persist. Resolve D§9.7.
- **Subnet labels.** Enable `ENABLE_SUBNET_LABELS` with and without the
  `subnet_cmds` hook loaded.
- **Kea-side setup guide.** Walk `docs/KEA_SETUP.md` exactly as written,
  including `cert-required: true`.
- **Credential failure.** Revoke the exporter's credential and confirm
  `kea_up 0` and `poll_errors_total{reason="auth"}`.

Resolve D§9.3–9.9 where the available topology allows. Record any item that
cannot be exercised without changing a production configuration as such,
rather than leaving it implied.

Everything is recorded in `docs/LIVE_VALIDATION.md`, using placeholder names
only, including which fixtures were reconciled against real captures and which
stayed hand-authored, and why.

**Exit:** every fixture that a real server can produce is a sanitised real
capture; every shipped alert has been observed firing at least once against
real or crafted data; D§9 is updated.

Once this bar is met, promote `CHANGELOG.md`'s `[Unreleased]` section to
`[0.1.0]` and push the first real tag (Phase 14's deferred exit condition).

---

## Testing strategy

**Unit.** Every module under `node:test`. Pure parse, map and render functions
are tested against fixtures. Redaction is tested in both directions: the
placeholder appears, and the secret does not. Absence is tested explicitly:
"missing input yields no series" is its own test, never inferred from a
value-is-correct test.

**Golden files.** The full `/metrics` exposition per scenario, compared byte for
byte: a DHCPv4 HA primary, a DHCPv4 HA standby, a DHCPv6 target, a DDNS target,
HA absent, subnet labels on. This turns an accidental metric rename, an added
label or a reordering into a failing test rather than a silent breaking change
for every downstream dashboard. Changing a golden file requires a
`CHANGELOG.md` entry.

**Integration.** A mock Kea control socket in `test/support/mock-kea-server.ts`,
serving fixtures per command with scriptable failures. It covers:

- a full poll cycle;
- concurrent multi-target scrapes;
- per-target failure isolation;
- series disappearance (subnet, pool, HA relationship, DDNS key);
- the array and bare-object envelopes;
- HTTP 401 and 403;
- results 1, 2 and 3;
- an HA state transition sequence across cycles;
- a counter reset across a simulated reload;
- an over-size response;
- stale cache;
- graceful shutdown;
- TLS, client-certificate TLS, and mTLS on the metrics listener;
- a `dist/` smoke test in a real subprocess;
- Docker image hygiene;
- a soak run (100 cycles in CI) checking heap, handle count and series count
  stability.

**Not in CI.** Anything needing a real Kea server. That is Phase 15.

---

## Verification

```bash
npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run check

cp example.env .env      # set KEA_TARGETS, KEA_DAEMON, KEA_USERNAME, KEA_PASSWORD_FILE
node dist/index.js

curl -s localhost:10167/healthz
curl -s localhost:10167/readyz                       # ready after the first cycle
curl -s localhost:10167/metrics | head               # global registry only
curl -s "localhost:10167/metrics?target=dhcp4-a" \
  | grep -E '^kea_(up|ha_state|dhcp4_packets_received_all_total)'
curl -s -o /dev/null -w '%{http_code}\n' "localhost:10167/metrics?target=nope"   # 400
```

Honest-health check (N6):

1. Stop one Kea daemon. `kea_up` goes to 0, and other targets are unaffected.
   On its HA partner, `kea_ha_communication_interrupted` goes to 1.
2. Revoke the exporter's credential. `kea_up` goes to 0 and
   `kea_exporter_poll_errors_total{reason="auth"}` rises.
3. Restore both. `kea_up` returns to 1, and the HA pair returns to its
   operational states.

Diagnostics, alerts and container:

```bash
node dist/index.js --dump-raw > ./raw.json           # chmod 600; review before sharing, then delete

promtool check rules alerts/kea.yaml
promtool test rules alerts/kea.test.yaml

docker build -t kea-metrics-exporter .
docker run --rm --env-file .env -p 10167:10167 kea-metrics-exporter
```

Kubernetes: apply `deploy/kubernetes/`, confirm the pod reaches Ready, then
confirm on the Prometheus targets page that each configured target appears as
its **own** target, with `instance` set to the target name and `up == 1`.
