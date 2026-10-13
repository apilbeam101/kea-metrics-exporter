import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Agent } from "undici";
import { Secret } from "../../../src/config/secret.ts";
import { createAgent } from "../../../src/http/agent.ts";
import { KeaClient } from "../../../src/http/client.ts";
import { systemClock } from "../../../src/http/clock.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";

const TLS = join(process.cwd(), "test", "support", "tls");
const pem = (name: string) => readFileSync(join(TLS, name), "utf8");
const path = (name: string) => join(TLS, name);

const OK = JSON.stringify([{ result: 0, arguments: {} }]);

function listen(options: Parameters<typeof createServer>[0]): Promise<Server> {
  const server = createServer(options, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OK);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function url(server: Server): string {
  // 127.0.0.1, not localhost: localhost may resolve to ::1 first on Linux, and
  // the test certificates carry an IP:127.0.0.1 SAN.
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const agents: Agent[] = [];

function agentFor(options: Partial<Parameters<typeof createAgent>[0]>): Agent {
  const agent = createAgent({
    caBundlePath: undefined,
    clientCertPath: undefined,
    clientKeyPath: undefined,
    tlsInsecureSkipVerify: false,
    ...options,
  });
  agents.push(agent);
  return agent;
}

function call(server: Server, dispatcher: Agent) {
  return new KeaClient({
    baseUrl: url(server),
    username: "metrics",
    password: new Secret("s3cret"),
    dispatcher,
    clock: systemClock,
    budgetMs: 5000,
    maxResponseBytes: 1024 * 1024,
  }).command("status-get");
}

const rejectsAsNetwork = (promise: Promise<unknown>) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof KeaHttpError && error.reason === "network",
  );

describe("createAgent", () => {
  let serverA: Server;
  let serverB: Server;
  let mtlsServer: Server;

  before(async () => {
    serverA = await listen({ cert: pem("server-a-cert.pem"), key: pem("server-a-key.pem") });
    serverB = await listen({ cert: pem("server-b-cert.pem"), key: pem("server-b-key.pem") });
    mtlsServer = await listen({
      cert: pem("server-a-cert.pem"),
      key: pem("server-a-key.pem"),
      ca: pem("ca-a-cert.pem"),
      requestCert: true,
      rejectUnauthorized: true,
    });
  });

  after(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    for (const server of [serverA, serverB, mtlsServer]) server.close();
  });

  it("trusts a server issued by the target's own CA bundle", async () => {
    const response = await call(serverA, agentFor({ caBundlePath: path("ca-a-cert.pem") }));
    assert.equal(response.statusCode, 200);
  });

  it("keeps each target's CA scoped to its own agent", async () => {
    const agentA = agentFor({ caBundlePath: path("ca-a-cert.pem") });
    const agentB = agentFor({ caBundlePath: path("ca-b-cert.pem") });
    assert.equal((await call(serverB, agentB)).statusCode, 200);
    await rejectsAsNetwork(call(serverB, agentA));
    await rejectsAsNetwork(call(serverA, agentB));
  });

  it("rejects a private-CA server when no CA bundle is configured", async () => {
    await rejectsAsNetwork(call(serverA, agentFor({})));
  });

  it("presents a client certificate when one is configured", async () => {
    const agent = agentFor({
      caBundlePath: path("ca-a-cert.pem"),
      clientCertPath: path("client-cert.pem"),
      clientKeyPath: path("client-key.pem"),
    });
    assert.equal((await call(mtlsServer, agent)).statusCode, 200);
  });

  it("is refused by a server requiring a client certificate when none is configured", async () => {
    await rejectsAsNetwork(call(mtlsServer, agentFor({ caBundlePath: path("ca-a-cert.pem") })));
  });

  it("skips verification only when explicitly told to", async () => {
    const response = await call(serverB, agentFor({ tlsInsecureSkipVerify: true }));
    assert.equal(response.statusCode, 200);
  });
});
