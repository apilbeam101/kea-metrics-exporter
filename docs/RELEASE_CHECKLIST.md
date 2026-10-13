# Release checklist

Work through this before pushing a `v*.*.*` tag. The release workflow
re-verifies the tagged commit, and fails if the tag does not match
`package.json` or if `CHANGELOG.md` has no section for the version. Those
are its gates; everything else here is a person's job.

## Every release

- [ ] `main` is green in CI, including the Docker build, the container tests
      and the secret scan.
- [ ] `CHANGELOG.md`: `[Unreleased]` is promoted to `[x.y.z] - YYYY-MM-DD`,
      and every change to the public surface is recorded. The public surface
      is metric names, label names, state-set values and environment variable
      names. A rename or removal is a major version (DESIGN.md §10).
- [ ] `package.json` `version` matches the tag, without the `v`.
- [ ] Image tags in `deploy/docker-compose.yml`, `deploy/kubernetes/deployment.yaml`
      and `docs/INSTALL_DOCKER.md` name the new version.
- [ ] `npm run generate:metrics-doc` and `npm run generate:dashboard` leave
      no diff. The drift tests already enforce this.
- [ ] No fixture, golden file or doc contains a real address, hostname, HA
      server name or credential (`npm run check:fixtures`, then a manual
      read of anything added since the last release).

## First release only (v0.1.0)

- [ ] Phase 15 live validation is recorded in `docs/LIVE_VALIDATION.md`.
- [ ] The default port, 10167, is re-checked as unallocated in the Prometheus
      default-port allocation registry, and this exporter's entry is added
      there (DESIGN.md §9.1). Changing the port after v0.1.0 breaks every
      deployed manifest.
- [ ] A dry-run tag on a fork has produced the following:
  - [ ] a multi-arch image on GHCR, with build provenance for the manifest
        and a per-architecture SPDX SBOM, each verifiable with
        `gh attestation verify oci://ghcr.io/<fork-owner>/kea-metrics-exporter:<tag> --owner <fork-owner>`;
  - [ ] a GitHub Release whose notes are the matching `CHANGELOG.md` section.

## Repository settings, once

- [ ] Branch protection on `main`: require the CI checks and the DCO check.
- [ ] Private vulnerability reporting enabled (SECURITY.md links to it).
- [ ] Secret scanning and push protection enabled.
- [ ] For the Docker Hub mirror, `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
      secrets are set. The mirror is best-effort, and a release succeeds
      without it.
- [ ] Only to publish to npm: the `NPM_PUBLISH_ENABLED` variable is set to
      `true` and the `NPM_TOKEN` secret is set.

## After tagging

- [ ] The release workflow is green. Verify the image:
      `gh attestation verify oci://ghcr.io/apilbeam101/kea-metrics-exporter:<version> --owner apilbeam101`.
- [ ] Pull the image and run the verification steps from
      [INSTALL_DOCKER.md](INSTALL_DOCKER.md#verify).
