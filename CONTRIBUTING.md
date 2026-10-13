# Contributing

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check    # supply-chain guards: no native addons, pack allowlist, license allowlist, audit
```

Every change should leave `npm run typecheck && npm run lint && npm test &&
npm run build && npm run check` green. See
[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for the current build phase,
the module layout, and the shared primitives to reuse rather than reimplement.

## Design changes

If a change alters what the exporter exposes or why, update
[docs/DESIGN.md](docs/DESIGN.md) in the same pull request. If it only changes
how something gets built, [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) is
the right place instead.

## Read-only by construction

The exporter's Kea credential can run every command, including writes, because
open-source Kea has no per-command access control. The exporter's own code is
therefore the only thing keeping it read-only. A pull request must never:

- add a command to `src/http/command-allowlist.ts` that Kea classifies as
  `write`;
- add a way to send command `arguments`;
- call `config-get`, whose response contains plaintext secrets.

See [docs/DESIGN.md](docs/DESIGN.md) §6.3.

## Publishing scope

This project is self-contained. Nothing committed (code, comments, docs,
commit messages, fixtures, manifests, dashboards or alert rules) may
reference private infrastructure. Example and fixture values use:

- `example.com` and `example.net`;
- `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`;
- HA server names `server1`, `server2`;
- target names such as `dhcp4-a`, `dhcp4-b`, `dhcp6-a`, `d2-a`.

Never commit a raw capture from a real Kea server. Run it through
`scripts/sanitize-fixtures.ts` first.

## Commit sign-off (DCO)

Every commit must include a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds a line like:

```
Signed-off-by: Your Name <you@example.com>
```

Pull requests fail the DCO check in CI if any commit is unsigned, or if a
commit's `Signed-off-by` trailer does not match its author or committer
email.

## Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Do not open a public issue for a security
report.
