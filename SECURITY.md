# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately, using
[GitHub Security Advisories](../../security/advisories/new) for this
repository. Do not open a public issue for a security report.

We aim to acknowledge new reports promptly and to disclose fixed
vulnerabilities responsibly once a patched release is available.

## Supported versions

Only the latest minor release line receives security fixes until v1.0.0
ships. This section will be updated once a formal support window is
established.

## The exporter's Kea credential is administrative

Open-source Kea's control-socket authentication is all-or-nothing. Any user
that can authenticate can run every command, including configuration changes,
lease deletion and shutdown. Per-command access control needs the RBAC hook,
which ISC provides to support subscribers only.

The exporter itself is read-only by construction: it can only send a fixed
set of read commands, never with arguments. See
[docs/DESIGN.md](docs/DESIGN.md) §6.3. That protects against the exporter
misbehaving. It does not protect against the credential being stolen. Treat
the credential as an administrative one, and apply these controls, strongest
first:

1. Give the exporter **its own control socket**, bound to a management address
   rather than a client-facing one, with an `authentication` block that lists
   only the exporter's user.
2. **Restrict who can reach that socket** to the exporter, using a host
   firewall or a network policy.
3. Use **HTTPS with `cert-required: true`**, so a password alone is not enough.
4. Use a **distinct user name** for the exporter, so its requests are
   attributable in Kea's logs.
5. Keep credentials in Kea's **`user-file` / `password-file`**. Kea 3.x refuses
   to start with clear-text credentials in its configuration.
6. If you have it, use the **RBAC hook** with a role limited to `version-get`,
   `status-get`, `statistic-get-all`, `config-hash-get`, `subnet4-list` and
   `subnet6-list`. This is the only control that makes the credential itself
   read-only.

See [docs/DESIGN.md](docs/DESIGN.md) §6.4.

## Handling of secrets

- The exporter reads its password from a file (`KEA_PASSWORD_FILE`) or an
  environment variable (`KEA_PASSWORD`), and TLS key material only from file
  paths. There is no on-disk configuration format of its own that could leak
  one.
- No secret is ever written to a log, error message, metric, configuration
  summary or `--dump-raw` diagnostic dump. See [docs/DESIGN.md](docs/DESIGN.md)
  N5 and §6.5.
- The exporter never calls `config-get`, whose response contains database
  passwords in plaintext.
