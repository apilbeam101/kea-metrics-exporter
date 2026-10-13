# kea-metrics-exporter

A [Prometheus](https://prometheus.io/) exporter for [ISC Kea
DHCP](https://www.isc.org/kea/), built around the signal Kea's existing
exporters do not provide: **high-availability state**. Which server is serving,
whether the partner is reachable, and how close a pair is to failing over.

**Status:** pre-release. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
for current progress.

## Why

A Kea HA pair can quietly lose its redundancy. A standby stuck in `waiting`,
or `terminated` by clock skew, leaves the active server answering normally
and every lease graph flat, until the active server fails and there is no
partner to take over. This exporter reads Kea's control API and exports:

- HA state per relationship, joinable across both servers of a pair;
- packet, drop-reason, lease and pool-utilisation metrics for DHCPv4 and
  DHCPv6, correctly typed as counters and gauges;
- DHCP-DDNS update outcomes;
- one honest health signal per Kea daemon.

It is strictly read-only against Kea: no mutating command can be expressed in
its code.

See [docs/DESIGN.md](docs/DESIGN.md) for the requirements, the upstream API
behaviour the design accounts for, and the complete metric surface.

## Quick start

```bash
npm ci
npm run build

cp example.env .env      # set KEA_TARGETS, KEA_DAEMON, KEA_USERNAME, KEA_PASSWORD_FILE
node dist/index.js
```

```bash
curl -s localhost:10167/healthz
curl -s "localhost:10167/metrics?target=<name>"
```

Full install instructions, after preparing Kea with
[docs/KEA_SETUP.md](docs/KEA_SETUP.md):

- [docs/INSTALL_STANDALONE.md](docs/INSTALL_STANDALONE.md)
- [docs/INSTALL_DOCKER.md](docs/INSTALL_DOCKER.md)
- [docs/INSTALL_KUBERNETES.md](docs/INSTALL_KUBERNETES.md)

## Monitoring

- [dashboards/kea.json](dashboards/kea.json): a generated Grafana dashboard.
  Exporter health comes first, then HA state for every relationship, instance
  overview, DHCPv4 and DHCPv6 packets, drops and pool utilisation, and
  DHCP-DDNS.
- [alerts/kea.yaml](alerts/kea.yaml): Prometheus alert rules for exporter and
  daemon health, HA (including split brain and imminent failover), pool
  exhaustion, allocation failures, packet drops and DDNS updates. Each rule
  has `promtool` unit tests in [alerts/kea.test.yaml](alerts/kea.test.yaml).

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md): what the exporter exposes, and why
- [docs/METRICS.md](docs/METRICS.md): every metric, generated from the code
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): how it is being built
- [SECURITY.md](SECURITY.md): vulnerability reporting, and securing the Kea
  control socket the exporter reads from
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute

## License

[Apache-2.0](LICENSE)
