# Installing with Docker

Runs the published multi-architecture image (`linux/amd64`, `linux/arm64`).
Prepare Kea first: [KEA_SETUP.md](KEA_SETUP.md).

## Configure

In the directory that will hold the deployment:

```bash
cp example.env .env                   # set KEA_TARGETS, KEA_DAEMON, KEA_USERNAME
printf '%s' 'the-kea-password' > kea-password.txt
sudo chown 10001 kea-password.txt     # the image runs as UID 10001
chmod 0400 kea-password.txt
```

Leave `KEA_PASSWORD` and `KEA_PASSWORD_FILE` out of `.env`: the compose file
mounts the password as a secret and points `KEA_PASSWORD_FILE` at it. Both
`.env` and `kea-password.txt` are listed in `.gitignore`.

## Run with Compose

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

In `deploy/docker-compose.yml`, pin the image tag you have reviewed. The
container runs with a read-only root filesystem, no capabilities and
`no-new-privileges`. The image's own `HEALTHCHECK` probes `/healthz`.

## Run with `docker run`

```bash
docker run -d --name kea-metrics-exporter \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --env-file .env \
  -e KEA_PASSWORD_FILE=/run/secrets/kea-password \
  -v "$PWD/kea-password.txt:/run/secrets/kea-password:ro" \
  -p 10167:10167 \
  ghcr.io/apilbeam101/kea-metrics-exporter:0.1.2
```

## Build it yourself

```bash
docker build -t kea-metrics-exporter .
```

The build context excludes `.env`, key material, password files, tests,
documentation and `scratch/`; see `.dockerignore`.

## Verify

```bash
curl -s localhost:10167/healthz
curl -s localhost:10167/readyz
curl -s "localhost:10167/metrics?target=dhcp4-a" | grep -E '^kea_(up|ha_state)'
docker inspect --format '{{.State.Health.Status}}' kea-metrics-exporter   # healthy
```
