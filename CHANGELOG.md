# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-13

### Added

- Design and implementation plan: `docs/DESIGN.md`, `docs/IMPLEMENTATION.md`.
- Project scaffold:
  - build and lint configuration: `package.json`, `tsconfig.json`,
    `tsconfig.test.json`, `biome.json`;
  - community files: `LICENSE` (Apache-2.0), `README.md`, `CONTRIBUTING.md`
    (with DCO), `CODE_OF_CONDUCT.md`, `SECURITY.md`;
  - `example.env`;
  - repository hygiene: `.gitignore`, `.gitattributes`, `.gitleaks.toml`,
    `.dockerignore`;
  - GitHub scaffolding: `dependabot.yml`, issue and PR templates.
- Supply-chain guard scripts, each with unit tests: `check-no-native-addons`,
  `check-pack-allowlist`, `check-license-compound`. They are aggregated behind
  `npm run check` together with a production `npm audit`.
- DCO sign-off checker (`check-dco`) over a commit range, for CI.
- Placeholder `src/index.ts`.
- Default listen port 10167.
- Hand-authored Kea 3.2 fixtures under `test/fixtures/`, covering every
  documented API hazard:
  - the array and bare-object response envelopes, and result codes 0–3;
  - `version-get` shapes;
  - `status-get` with multi-threading on and off, every disabled origin and
    every socket status, plus the DDNS daemon;
  - HA: a matched hot-standby pair, an interrupted load-balancing
    relationship, a hub with two relationships, passive-backup, an unknown
    state, and a sweep covering all 13 states;
  - `statistic-get-all` for DHCPv4, DHCPv6 and DDNS, including sample
    histories, missing and unknown statistics, and an exact 2^64 value;
  - subnet lists and configuration hashes.
- Leak detector and sanitiser (`src/sanitize.ts`) with a CLI
  (`scripts/sanitize-fixtures.ts`). It rejects anything outside
  documentation addresses, `example.*` names, documentation MACs and
  placeholder HA, shared-network and key names. RFC 1918, CGNAT and ULA
  space are rejected too. One mapping is shared across inputs, so both sides
  of an HA pair sanitise consistently.
- `npm run check:fixtures`, plus unit tests for the sanitiser, the guard
  (one planted leak per kind) and every fixture's shape.
- Configuration (`src/config/`):
  - environment and `--env-file` loading, with the process environment taking
    precedence;
  - validation that reports every error at once;
  - a deeply frozen result;
  - a redacted summary, and a `Secret` wrapper for the Kea password.
- Target rules:
  - named targets, with `__<NAME>` overrides for every per-target setting:
    daemon type, username, password or password file, CA bundle, client
    certificate and key, and skip-verify;
  - an orphan or wrong-case override is a startup error;
  - credentials in a URL are rejected;
  - plain `http` targets and disabled verification produce warnings.
- Password precedence: a per-target password of either form replaces both
  global forms. Setting both forms in one scope is an error. Password files
  are read once, and only the trailing line terminator is stripped.
- HTTP layer (`src/http/`): `KeaClient.command(name)`. It POSTs
  `{"command": name}`, with no way to attach arguments, to the fixed path
  `/`, using basic auth built at request time.
  - Each logical call has a wall-clock budget, with retry and backoff for
    network, timeout and 5xx failures.
  - Response bodies are streamed with a `MAX_RESPONSE_BYTES` cap.
  - Redirects are never followed.
  - Every attempt is reported as telemetry.
- Read-only command allowlist (`src/http/command-allowlist.ts`), tested
  against a list of Kea write commands and of reads that expose
  configuration or per-client data.
- One TLS agent per target, carrying only that target's CA bundle and client
  certificate, with TLS 1.2 minimum. Tests run against real HTTPS servers
  using a committed test-only PKI.
- Response envelope classifier (`src/api/envelope.ts`):
  - a one-element array or a bare 401/403 object;
  - result 2 is "unsupported" and result 3 is "empty", neither an error;
  - every other shape is malformed;
  - error text is bounded before it reaches a log line.
- Statistic name parser (`src/api/stat-name.ts`) for the global, subnet,
  pool, prefix-delegation-pool and TSIG-key scopes, with templating for
  unknown-name labels. Current-sample reader (`src/api/stat-sample.ts`).
- Status collector (`src/metrics/status-collector.ts`), with its metrics:
  - `kea_up` is derived only from the actual `status-get` outcome: written
    last on success and first on failure;
  - `kea_server_version_info{version,daemon}` and
    `kea_server_version_supported`, refetched after a detected restart
    (uptime going backwards);
  - start and reload timestamps;
  - `kea_service_globally_disabled` and `kea_service_disabled{origin}`;
  - `kea_control_socket_status` as a state set;
  - multi-threading, thread-pool, queue-size and queue-depth gauges, absent
    where the daemon does not report them.
- Shared per-target families (`kea_collector_success`,
  `kea_exporter_unknown_enum_total`) and a state-set renderer in
  `src/metrics/registry.ts`.
- High-availability collector (`src/metrics/ha-collector.ts`). It reads the
  HA section of the same `status-get` call, so it adds no upstream request.
  - Every series carries a `relationship` key built from both server names
    sorted, so both sides of a pair join without relabeling.
  - `kea_ha_state` and `kea_ha_partner_last_state` are state sets over all 13
    HA states. An unknown state is counted and leaves every series at 0.
  - `kea_ha_relationship_info`, scopes served, and the partner's last
    scopes.
  - Partner gauges: communication-interrupted, in-touch, age, clock skew,
    and the connecting, unacked, unacked-left and analysed failover counters.
  - Partner series are absent without a partner block.
  - With the HA hook absent, every `kea_ha_*` series is absent, as is the
    collector's own success series.
- Golden exposition files for HA scenarios, with an `UPDATE_GOLDEN=1`
  regeneration path.
- Statistics collector (`src/metrics/statistics-collector.ts`), driven by
  per-daemon statistic tables (`src/metrics/stat-map.ts`). The DHCPv4 table
  covers:
  - packets received and sent by type, each with a separate aggregate;
  - drops by reason, with a separate aggregate;
  - global, subnet and pool address capacity, assigned and declined counts;
  - assignments, reclamations, allocation failures by cause, lease reuses
    and reservation conflicts.
- Upstream-valued families (`src/metrics/upstream-family.ts`). Counters are
  typed `counter` and take Kea's own totals, so a reload reset is an ordinary
  counter reset to Prometheus. A missing statistic is an absent series.
- `MAX_SUBNETS` truncation, keeping the lowest subnet IDs, with
  `kea_exporter_subnets_truncated`. `ENABLE_POOL_STATS`.
- `kea_exporter_unknown_statistic_total{name}`, with indices templated out.
  `kea_exporter_parse_errors_total{group}`.
- `kea_daemon_mismatch`: statistics from another daemon empty this target's
  families instead of being rendered under the wrong names. It is absent
  while inconclusive.
- DHCPv6 statistic table:
  - packets received and sent by type, including DHCPv4-over-DHCPv6 and
    address registration;
  - drops by reason;
  - non-temporary address and delegated-prefix capacity and assignment, in
    separate pool and prefix-delegation-pool families;
  - lease reuses by `ia_type`;
  - registrations.
  A `total-nas` above 2^53 renders as the nearest float64.
- Multi-target poller with one registry per target (`src/poller/`).
  - Collectors are split into fetch and apply, and a render gate applies
    each cycle only while no render is in flight. A scrape never sees part
    of two cycles.
  - Renders are single-flighted per target.
  - A failed `status-get` skips the statistics call for that cycle.
- HTTP server (`src/server/`) with `/metrics` (global registry only),
  `/metrics?target=`, `/healthz`, `/readyz` and `/`. An unknown target is
  400; an unknown path is 404; a wrong method is 405 with `Allow`. Optional
  TLS and mTLS on the listener, plus listener hardening limits.
- Startup sequence (`src/index.ts`): the listener and signal handlers come
  up before any upstream call, and the summary is redacted. Also
  `kea_exporter_build_info` and `kea_exporter_targets`.
- Logger with redaction at the boundary (`src/log/`), and graceful shutdown
  (`src/lifecycle.ts`).
- Opt-in subnet labels (`ENABLE_SUBNET_LABELS`). They add `prefix` and
  `shared_network` to every subnet and pool series, from `subnet4-list` or
  `subnet6-list`.
  - `config-hash-get` runs every cycle, and the list is refetched only when
    the hash changes.
  - A missing `subnet_cmds` hook sets `kea_command_supported{command}` to 0,
    with one warning, and no list call is retried until the configuration
    changes.
  - A failed list call keeps the previous labels.
  - With the flag off, neither command is ever sent.
- DHCP-DDNS statistic table:
  - name change requests received, invalid, errored, and dropped on a full
    queue;
  - DNS updates sent, signed, unsigned, succeeded, timed out and failed.
  Per-TSIG-key update series (`kea_d2_key_*{key}`) sit behind
  `ENABLE_D2_KEY_STATS`. With it off they are skipped, not counted as
  unknown.
- Self-observability (`src/poller/self-metrics.ts`):
  - poll count, poll errors by reason, and poll duration;
  - upstream requests by command and status, their duration, and response
    sizes;
  - last successful poll time, and a cache age computed at scrape time;
  - the `kea_exporter_series` cardinality tripwire, and the TLS
    verification flag.
  Attempt telemetry is recorded with each cycle's apply, so it too never
  changes mid-render.
- `--dump-raw [--no-sanitize]`. It runs each allowlisted command once per
  target and writes one JSON document to stdout, with logs on stderr.
  - JSON bodies are spliced in verbatim, so values above 2^53 stay exact.
  - Output is sanitised by default, with one mapping across targets.
  - IPv4 networks beyond the documentation space are redacted rather than
    failing the dump.
- Generated `docs/METRICS.md` (`npm run generate:metrics-doc`), with a drift
  test. It lists every family with its type, labels, Kea source statistic
  and HELP text, plus the Stork-name mapping and the names whose meaning
  differs between the two exporters.
- Deployment artefacts:
  - a multi-stage `Dockerfile` with a non-root UID/GID of 10001, OCI labels,
    an exec-form entrypoint and a self-timing `HEALTHCHECK`
    (`src/healthcheck.ts`);
  - a hardened Compose file, with the password as a file secret;
  - a systemd unit with `DynamicUser`, a sandboxing set, and the password
    via `LoadCredential=`;
  - Kubernetes manifests: Deployment, Service, ConfigMap, example Secret,
    NetworkPolicy, and an optional ServiceMonitor.
- Install guides (`docs/INSTALL_STANDALONE.md`, `INSTALL_DOCKER.md`,
  `INSTALL_KUBERNETES.md`) and a Kea-side setup guide (`docs/KEA_SETUP.md`):
  a dedicated control socket, credential files, a network restriction,
  sample count, the optional `subnet_cmds` hook, and RBAC.
- Container image-hygiene and container tests, including graceful shutdown
  on SIGTERM. They are skipped where Docker is unavailable.
- Alert rules (`alerts/kea.yaml`), 22 rules:
  - exporter and daemon health;
  - collector failures, daemon mismatch, unsupported version, disabled
    service, and control-socket status;
  - HA: terminated, partner-down, split brain (deduplicated by server), no
    active server, communication interrupted, failover imminent, not
    operational, maintenance, and clock skew;
  - pool exhaustion, allocation failures, fault-reason packet drops, and
    DDNS update failures.
  `promtool` unit tests in `alerts/kea.test.yaml` show every rule firing and
  not firing.
- The worked PromQL queries in DESIGN.md §5.2, evaluated as recording rules
  under `promtool` (`test/promtool/`).
- Generated Grafana dashboard (`dashboards/kea.json`,
  `npm run generate:dashboard`). It has exporter health first and HA second,
  then instance overview, DHCPv4 and DHCPv6 packets, drops and utilisation,
  and DDNS, with `job`, `instance`, `relationship` and `subnet_id` variables.
- Tests for the dashboard and alerts:
  - dashboard drift and layout;
  - a metric-name cross-check against the declarations;
  - multi-exporter safety: `sum` only over rates, and `job`/`instance` in
    every matching clause;
  - every dashboard query parsed by `promtool`.
- `npm run fetch:promtool` and `npm run fetch:gitleaks` (pinned, sha256-verified), and
  `npm run check:alerts`.
- CI and release workflows (`.github/workflows/`):
  - `ci.yml`: a fast leg, a Linux/macOS/Windows by Node 24/current matrix,
    supply-chain guards with promtool, a full-history gitleaks scan, the DCO
    check on pull requests, and a multi-arch Docker build with the container
    tests;
  - `release.yml`: on `v*.*.*`, it re-verifies the commit, checks the tag
    against `package.json` and `CHANGELOG.md`, publishes an attested
    multi-arch image with per-architecture SBOMs to GHCR, mirrors it to
    Docker Hub best-effort, optionally publishes to npm, and creates a GitHub
    Release from the changelog;
  - `rebuild.yml`: a monthly base-image rebuild that republishes only
    `:latest`;
  - `scan.yml`: a monthly vulnerability scan to the Security tab.
  All actions are SHA-pinned.
- `npm run check:secrets` and `npm run changelog:extract`, and
  `docs/RELEASE_CHECKLIST.md`.
- Live validation against a Kea 3.2.1 hot-standby pair
  (`docs/LIVE_VALIDATION.md`). It covered steady state, a configuration
  reload, the standby and the primary each stopped and restarted, and
  maintenance mode. It found and fixed the following:
  - `null` HA fields while a partner is unreachable no longer freeze every HA
    series;
  - an unlearned partner state just after a restart no longer fails the HA
    collector;
  - derived start and reload timestamps no longer wobble between polls;
  - `KeaServiceDisabled` no longer fires during planned HA maintenance;
  - `KeaHANoActiveServer` and `KeaHASplitBrain` count only targets that are
    up, so a dead server's frozen series cannot hide an outage or fake a
    split brain.
  Partner `age` and `in-touch` HELP text now reflect the observed
  semantics.
- Integration tests against a mock Kea control socket. They cover
  independent targets, one target hard down, zero upstream requests per
  scrape, a rejected credential, routing errors, and shutdown.
