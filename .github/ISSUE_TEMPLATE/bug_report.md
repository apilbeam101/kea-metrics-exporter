---
name: Bug report
about: Report something that isn't working as documented
labels: bug
---

**Describe the bug**
A clear description of what's wrong and what you expected instead.

**Environment**
- Exporter version (`kea_exporter_build_info`):
- Kea version and daemon (`dhcp4` / `dhcp6` / `d2`):
- HA mode, if any (`hot-standby` / `load-balancing` / `passive-backup`):
- Deployment (standalone / Docker / Kubernetes):

**Relevant configuration**
Environment variable names and non-secret values only. Never paste
`KEA_PASSWORD`, the contents of a password file, or key material.

**Relevant metrics or logs**
The specific `kea_*` output or log lines involved. If you attach `--dump-raw`
output, review it first: it is sanitised by default, but subnet IDs, pool
layout and HA server names still describe your topology.
