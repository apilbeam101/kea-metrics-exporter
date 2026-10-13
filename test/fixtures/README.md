# Test fixtures

Kea control-socket responses, one JSON file per scenario, grouped by command.

Every fixture is **hand-authored** from the Kea 3.2 API definitions and
manual (docs/DESIGN.md §3) until Phase 15 replaces it with a sanitised capture
from a real server. When a fixture is replaced, update its row below.

| Directory | Command | Scenarios | Provenance |
|---|---|---|---|
| `envelope/` | any | result 0, 1, 2, 3; bare-object 403; two-element array; missing `result`; non-JSON body | hand-authored |
| `version/` | `version-get` | with and without `arguments.extended`; a 2.x version | hand-authored |
| `status/` | `status-get` | multi-threading on and off; every disabled origin; each socket status; the DDNS daemon | hand-authored |
| `ha/` | `status-get` | matched hot-standby pair; interrupted load-balancing; hub with two relationships; passive-backup with no `remote`; unknown state; a sweep covering all 13 states | hand-authored |
| `statistics/` | `statistic-get-all` | DHCPv4, DHCPv6 and DDNS, including 20-sample and single-sample histories, an empty sample list, a missing statistic, unknown names, and a 2^64 value | hand-authored |
| `subnets/` | `subnet4-list`, `subnet6-list` | with and without shared networks; hook absent (result 2); no subnets (result 3) | hand-authored |
| `config-hash/` | `config-hash-get` | two different hashes | hand-authored |

Shapes not yet confirmed against a live server are listed in
docs/DESIGN.md §9. In particular, the element types of the
`dhcp-state.disabled-by-*` lists are a placeholder.

## Rules

- Never commit a raw capture. Run it through the sanitiser first, passing both
  sides of an HA pair in one invocation so they share one name mapping:

  ```bash
  node --experimental-strip-types scripts/sanitize-fixtures.ts --out-dir <dir> <capture...>
  ```

  Then review the output by hand. The sanitiser rewrites addresses, names and
  credentials it can recognise. It cannot recognise every identifier that
  free text might contain.
- `npm run check:fixtures` must pass. It accepts only:
  - RFC 5737 and RFC 3849 documentation addresses;
  - `example.com`, `example.net` and `example.org` names;
  - RFC 7042 documentation MAC addresses;
  - HA server names `serverN`, shared networks `networkN` and TSIG keys `keyN`.
- Configuration hashes are placeholder strings. A real hash looks like a
  secret to the guard.
