# Test fixtures

Kea control-socket responses, one JSON file per scenario, grouped by command.

Every fixture is **hand-authored**. Fixtures are not replaced with real
captures, even sanitised ones: the sanitiser rewrites addresses and names,
but a capture would still publish a real deployment's subnet IDs, pool
layout, lease counts and traffic volumes. Phase 15 instead reconciled the
fixtures' shapes with live Kea 3.2.1 captures, which are kept outside the
repository (docs/LIVE_VALIDATION.md). Fixtures marked *shape-reconciled*
mirror a shape observed live, with placeholder values.

| Directory | Command | Scenarios | Provenance |
|---|---|---|---|
| `envelope/` | any | result 0, 1, 2, 3; bare-object 403; bare-object 401, the shape Kea 3.2.1 returns for a wrong password; two-element array; missing `result`; non-JSON body | hand-authored; 401 shape-reconciled |
| `version/` | `version-get` | with and without `arguments.extended`; a 2.x version | hand-authored |
| `status/` | `status-get` | multi-threading on and off; every disabled origin; each socket status; the DDNS daemon | hand-authored |
| `ha/` | `status-get` | matched hot-standby pair; partner unreachable (null clock skew and system time); server starting before it has learned its partner's state; interrupted load-balancing; hub with two relationships; passive-backup with no `remote`; unknown state; a sweep covering all 13 states | hand-authored; the hot-standby fixtures shape-reconciled |
| `statistics/` | `statistic-get-all` | DHCPv4, DHCPv6 and DDNS, including 20-sample and single-sample histories, an empty sample list, a missing statistic, unknown names, and a 2^64 value | hand-authored |
| `subnets/` | `subnet4-list`, `subnet6-list` | with and without shared networks; hook absent (result 2); no subnets (result 3) | hand-authored |
| `config-hash/` | `config-hash-get` | two different hashes | hand-authored |

Shapes not yet confirmed against a live server are listed in
docs/DESIGN.md §9. In particular, the element types of the
`dhcp-state.disabled-by-*` lists are a placeholder: the live lists were
empty.

## Rules

- Never commit a capture from a real server, raw or sanitised. To add a shape
  seen live, sanitise the capture locally as a starting point, passing both
  sides of an HA pair in one invocation so they share one name mapping:

  ```bash
  node --experimental-strip-types scripts/sanitize-fixtures.ts --out-dir <dir> <capture...>
  ```

  Then hand-author the fixture from it: keep the structure, and replace every
  count, subnet ID, pool layout and free-text message with invented values.
  The sanitiser rewrites addresses, names and credentials it can recognise. It
  does not touch numbers, and it cannot recognise every identifier that free
  text might contain.
- `npm run check:fixtures` must pass. It accepts only:
  - RFC 5737 and RFC 3849 documentation addresses;
  - `example.com`, `example.net` and `example.org` names;
  - RFC 7042 documentation MAC addresses;
  - HA server names `serverN`, shared networks `networkN` and TSIG keys `keyN`.
- Configuration hashes are placeholder strings. A real hash looks like a
  secret to the guard.
