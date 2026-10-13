# Preparing Kea for the exporter

The exporter reads each Kea daemon's own control socket: `kea-dhcp4`,
`kea-dhcp6` and `kea-dhcp-ddns`, each on its own port. Kea 3.x has no
Control Agent. This guide sets up that socket safely. It applies to every
install path.

Read [DESIGN.md](DESIGN.md) §6.4 first. In open-source Kea, any user that can
authenticate to a control socket can run every command, including
configuration changes and shutdown. The exporter only ever sends six read
commands, but the credential you give it is administrative. The steps below
limit who can use that credential and from where.

## 1. Create the exporter's credential files

Kea 3.x refuses to start with clear-text credentials in its configuration,
so the user name and password live in files that only Kea can read:

```bash
sudo install -d -m 0750 -o root -g _kea /etc/kea/auth
printf 'metrics' | sudo tee /etc/kea/auth/metrics-user >/dev/null
openssl rand -base64 30 | tr -d '\n' | sudo tee /etc/kea/auth/metrics-password >/dev/null
sudo chmod 0640 /etc/kea/auth/metrics-user /etc/kea/auth/metrics-password
sudo chown root:_kea /etc/kea/auth/metrics-user /etc/kea/auth/metrics-password
```

The group Kea runs as differs between distributions and container images;
replace `_kea` with yours. Copy the same password into the exporter's
password file (step 4).

Use a user name that identifies the exporter, so its requests are
attributable in Kea's logs. Do not reuse an administrator's account.

## 2. Add a dedicated control socket

Give the exporter a control socket of its own, bound to a management
address, with an `authentication` block that lists only the exporter's user.
Kea accepts several entries in `control-sockets`, so an existing
administrative socket can stay as it is.

```json
{
  "Dhcp4": {
    "control-sockets": [
      {
        "socket-type": "https",
        "socket-address": "192.0.2.10",
        "socket-port": 8004,
        "trust-anchor": "/etc/kea/tls/ca.pem",
        "cert-file": "/etc/kea/tls/kea-server.pem",
        "key-file": "/etc/kea/tls/kea-server-key.pem",
        "cert-required": true,
        "authentication": {
          "type": "basic",
          "realm": "kea-dhcpv4-server",
          "directory": "/etc/kea/auth",
          "clients": [
            { "user-file": "metrics-user", "password-file": "metrics-password" }
          ]
        }
      }
    ]
  }
}
```

- `cert-required: true` is Kea's default for HTTPS sockets. The exporter then
  needs `KEA_CLIENT_CERT_PATH` and `KEA_CLIENT_KEY_PATH`, and a stolen
  password alone is not enough.
- Plain `"socket-type": "http"` also works. The password then crosses the
  network in clear text, and the exporter logs a warning at startup.
- Repeat for `Dhcp6` and `DhcpDdns` on their own ports if you monitor them.

## 3. Limit who can reach it

Allow only the exporter's address to connect to the control socket port,
with a host firewall on the Kea server, a network policy, or both. For
example, with nftables:

```
table inet kea_control {
  chain input {
    type filter hook input priority 0;
    tcp dport 8004 ip saddr 198.51.100.20 accept
    tcp dport 8004 drop
  }
}
```

## 4. Keep statistics small

Kea keeps up to 20 samples of every statistic by default, and the exporter
reads only the newest. Setting the daemon's default sample count to 1 makes
each `statistic-get-all` response many times smaller:

```json
{ "Dhcp4": { "statistic-default-sample-count": 1 } }
```

The exporter never sets this itself, because every command that changes it
is a write command.

## 5. Optional: subnet labels

`ENABLE_SUBNET_LABELS=true` adds each subnet's prefix and shared-network
name to its series. That needs the `subnet_cmds` hook loaded in the DHCP
daemon:

```json
{ "Dhcp4": { "hooks-libraries": [ { "library": "libdhcp_subnet_cmds.so" } ] } }
```

Without the hook, the exporter reports `kea_command_supported{command="subnet4-list"} 0`
and leaves the labels empty.

## 6. Strongest option: RBAC

If you have ISC's RBAC hook, give the exporter a role that allows only
`version-get`, `status-get`, `statistic-get-all`, `config-hash-get`,
`subnet4-list` and `subnet6-list`. This is the only control that makes the
credential itself read-only.

## Check it

From the exporter's host. curl prompts for the password, which keeps it out
of the shell history and the process list:

```bash
curl -s --cacert ca.pem --cert client.pem --key client-key.pem \
  -u metrics \
  -H 'Content-Type: application/json' \
  -d '{"command":"status-get"}' https://192.0.2.10:8004/
```

A one-element JSON array with `"result": 0` means the socket and credential
work. `{"result": 403, ...}` means the credential was rejected.
