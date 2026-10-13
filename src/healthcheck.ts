// The container HEALTHCHECK probe, run as its own short-lived process. It
// enforces its own timeout: Docker's --timeout marks a check failed but does
// not kill the process, so a hung server would otherwise leak one Node
// process per check.
import * as http from "node:http";
import * as https from "node:https";

const TIMEOUT_MS = 5_000;

// The listener's own address when it is bound to one, loopback when it is
// bound to every interface.
export function probeHost(bindAddress: string | undefined): string {
  if (bindAddress === undefined || bindAddress === "" || bindAddress === "0.0.0.0")
    return "127.0.0.1";
  if (bindAddress === "::") return "::1";
  return bindAddress;
}

function main(): void {
  const port = process.env.METRICS_PORT || "10167";
  const client = (process.env.METRICS_TLS_CERT_PATH ?? "") !== "" ? https : http;

  const req = client.request(
    {
      host: probeHost(process.env.METRICS_BIND_ADDRESS),
      port,
      path: "/healthz",
      method: "GET",
      timeout: TIMEOUT_MS,
      // A loopback liveness probe: whether the listener's certificate is
      // self-signed is irrelevant to whether the process is answering.
      rejectUnauthorized: false,
    },
    (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    },
  );
  // The timeout option only emits this event; the abort must be explicit.
  req.on("timeout", () => {
    req.destroy();
    process.exit(1);
  });
  req.on("error", () => process.exit(1));
  req.end();
}

if (process.argv[1]?.endsWith("healthcheck.js") || process.argv[1]?.endsWith("healthcheck.ts")) {
  main();
}
