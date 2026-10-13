# Installing as a standalone service

Runs the exporter as a Node.js process under systemd. Prepare Kea first:
[KEA_SETUP.md](KEA_SETUP.md).

## Requirements

- Node.js 24 or later.
- Network access from this host to each Kea control socket.

## Install

```bash
sudo install -d /opt/kea-metrics-exporter
# From a release tarball, or a checkout built with `npm ci && npm run build`:
sudo cp -r dist package.json package-lock.json /opt/kea-metrics-exporter/
cd /opt/kea-metrics-exporter && sudo npm ci --omit=dev --ignore-scripts
```

## Configure

```bash
sudo install -d -m 0750 /etc/kea-metrics-exporter
sudo cp example.env /etc/kea-metrics-exporter/exporter.env
sudo chmod 0600 /etc/kea-metrics-exporter/exporter.env
sudo install -m 0600 /dev/null /etc/kea-metrics-exporter/kea-password
sudoedit /etc/kea-metrics-exporter/kea-password     # the password only, no newline needed
sudoedit /etc/kea-metrics-exporter/exporter.env
```

In `exporter.env`:

- Set `KEA_TARGETS`, `KEA_DAEMON` and `KEA_USERNAME`.
- Leave `KEA_PASSWORD_FILE` and `KEA_PASSWORD` unset. The unit sets
  `KEA_PASSWORD_FILE` itself, from a systemd credential.

See [DESIGN.md](DESIGN.md) §6 for every variable.

## Run

```bash
sudo cp deploy/systemd/kea-metrics-exporter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kea-metrics-exporter
journalctl -u kea-metrics-exporter -f
```

The unit runs under a dynamic user with a read-only filesystem view and no
capabilities. It receives the password through `LoadCredential=`, so the
file stays readable by root only.

## Verify

```bash
curl -s localhost:10167/healthz                     # ok
curl -s localhost:10167/readyz                      # ready, once every target has been polled
curl -s localhost:10167/metrics | head              # global series only
curl -s "localhost:10167/metrics?target=dhcp4-a" | grep -E '^kea_(up|ha_state)'
```

`kea_up 1` for every target means each daemon was reached and accepted the
credential. Then add the scrape configuration from
[INSTALL_KUBERNETES.md](INSTALL_KUBERNETES.md#prometheus-scrape-configuration),
with `__address__` pointing at this host.
