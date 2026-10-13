import { readFileSync } from "node:fs";
import { Agent } from "undici";

export interface AgentOptions {
  readonly caBundlePath: string | undefined;
  readonly clientCertPath: string | undefined;
  readonly clientKeyPath: string | undefined;
  readonly tlsInsecureSkipVerify: boolean;
}

// One Agent per target, carrying only that target's trust and client
// identity. NODE_EXTRA_CA_CERTS is deliberately not used: it would widen
// every target's trust to every other target's private CA.
export function createAgent(options: AgentOptions): Agent {
  const read = (path: string | undefined) =>
    path === undefined ? undefined : readFileSync(path, "utf8");

  return new Agent({
    connect: {
      ca: read(options.caBundlePath),
      cert: read(options.clientCertPath),
      key: read(options.clientKeyPath),
      minVersion: "TLSv1.2",
      rejectUnauthorized: !options.tlsInsecureSkipVerify,
    },
  });
}
