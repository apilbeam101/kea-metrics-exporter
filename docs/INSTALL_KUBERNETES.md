# Installing on Kubernetes

Prepare Kea first: [KEA_SETUP.md](KEA_SETUP.md). Kea commonly runs with host
networking or outside the cluster. The exporter reaches it over ordinary TCP
and needs no host networking or privilege of its own.

## Apply

```bash
kubectl create secret generic kea-metrics-exporter-credentials \
  --from-file=password=./kea-password.txt
# Edit KEA_TARGETS, KEA_DAEMON and KEA_USERNAME first.
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
kubectl apply -f deploy/kubernetes/networkpolicy.yaml   # adjust selectors, CIDRs and ports first
```

`secret.example.yaml` shows the Secret's shape. Do not commit one with a real
password: create the Secret from a file as above, or through your cluster's
secret management.

The Deployment runs:

- one replica, with the `Recreate` strategy;
- non-root UID 10001, a read-only root filesystem, no capabilities and the
  `RuntimeDefault` seccomp profile;
- no service-account token;
- `/healthz` liveness and `/readyz` readiness probes.

The password is mounted as a file and read through `KEA_PASSWORD_FILE`.

## Prometheus scrape configuration

Each Kea daemon is its own scrape target: the target name becomes both the
`?target=` parameter and the `instance` label. Annotation-based discovery
does not work for this: it would scrape the exporter's address with no
`target` parameter and collect only the global series.

```yaml
scrape_configs:
  - job_name: kea
    metrics_path: /metrics
    static_configs:
      - targets: [dhcp4-a, dhcp4-b]
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: kea-metrics-exporter.monitoring.svc:10167
```

### Optional: Prometheus Operator

Only if the cluster runs the Prometheus Operator, which provides the
ServiceMonitor CRD. Applying this elsewhere fails.

```bash
kubectl apply -f deploy/kubernetes/servicemonitor.example.yaml
```

It needs one endpoint per target; edit the names to match `KEA_TARGETS`.

## Verify

```bash
kubectl rollout status deployment/kea-metrics-exporter
kubectl port-forward deployment/kea-metrics-exporter 10167:10167 &
curl -s localhost:10167/readyz
curl -s "localhost:10167/metrics?target=dhcp4-a" | grep -E '^kea_(up|ha_state)'
```

Then confirm on the Prometheus targets page that each Kea daemon appears as
its own target, with `instance` set to the target name and `up == 1`.
