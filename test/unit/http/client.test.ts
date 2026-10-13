import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MockAgent } from "undici";
import { Secret } from "../../../src/config/secret.ts";
import { KeaClient, type UpstreamAttemptOutcome } from "../../../src/http/client.ts";
import { type Clock, systemClock } from "../../../src/http/clock.ts";
import type { AllowedCommand } from "../../../src/http/command-allowlist.ts";
import { KeaHttpError } from "../../../src/http/errors.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { KEA_WRITE_COMMANDS } from "../../support/kea-commands.ts";

const ORIGIN = "https://kea-a.example.com:8004";
const AUTH = `Basic ${Buffer.from("metrics:s3cret").toString("base64")}`;

let active: MockAgent | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

function mockAgent(): MockAgent {
  active = new MockAgent();
  active.disableNetConnect();
  return active;
}

function client(
  agent: MockAgent,
  overrides: {
    baseUrl?: string;
    budgetMs?: number;
    clock?: Clock;
    maxResponseBytes?: number;
    attempts?: UpstreamAttemptOutcome[];
  } = {},
): KeaClient {
  const attempts = overrides.attempts;
  return new KeaClient({
    baseUrl: overrides.baseUrl ?? ORIGIN,
    username: "metrics",
    password: new Secret("s3cret"),
    dispatcher: agent,
    clock: overrides.clock ?? new FakeClock(),
    budgetMs: overrides.budgetMs ?? 15000,
    maxResponseBytes: overrides.maxResponseBytes ?? 1024 * 1024,
    ...(attempts === undefined ? {} : { onUpstreamAttempt: (o) => attempts.push(o) }),
  });
}

const OK = JSON.stringify([{ result: 0, arguments: {} }]);

describe("KeaClient.command", () => {
  it("POSTs only the command name to / with basic auth and a JSON content type", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: "/",
        method: "POST",
        body: '{"command":"status-get"}',
        headers: { authorization: AUTH, "content-type": "application/json" },
      })
      .reply(200, OK);

    const response = await client(agent).command("status-get");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, OK);
  });

  it("sends a body with exactly one key for every allowlisted command", async () => {
    const agent = mockAgent();
    const bodies: string[] = [];
    agent
      .get(ORIGIN)
      .intercept({ path: "/", method: "POST" })
      .reply(200, (options) => {
        bodies.push(String(options.body));
        return OK;
      })
      .times(6);
    const kea = client(agent);
    for (const name of [
      "version-get",
      "status-get",
      "statistic-get-all",
      "config-hash-get",
      "subnet4-list",
      "subnet6-list",
    ] as const) {
      await kea.command(name);
    }
    for (const body of bodies) {
      assert.deepEqual(Object.keys(JSON.parse(body)), ["command"]);
    }
  });

  it("rejects every write command before any request is made", async () => {
    const agent = mockAgent();
    const kea = client(agent);
    for (const name of KEA_WRITE_COMMANDS) {
      await assert.rejects(
        () => kea.command(name as unknown as AllowedCommand),
        /not in the read-only allowlist/,
      );
    }
    agent.assertNoPendingInterceptors();
  });

  it("keeps a base URL path prefix and does not double a trailing slash", async () => {
    const agent = mockAgent();
    const proxy = "https://proxy.example.com";
    agent.get(proxy).intercept({ path: "/kea/dhcp4/", method: "POST" }).reply(200, "prefixed");
    agent.get(ORIGIN).intercept({ path: "/", method: "POST" }).reply(200, "slash");

    assert.equal(
      (await client(agent, { baseUrl: `${proxy}/kea/dhcp4` }).command("status-get")).body,
      "prefixed",
    );
    assert.equal(
      (await client(agent, { baseUrl: `${ORIGIN}/` }).command("status-get")).body,
      "slash",
    );
  });

  it("returns a 4xx response for the envelope layer to classify, without retrying", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: "/", method: "POST" })
      .reply(401, JSON.stringify({ result: 401, text: "Unauthorized" }));
    const response = await client(agent).command("status-get");
    assert.equal(response.statusCode, 401);
  });

  it("does not follow a redirect, so the credential never reaches its target", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: "/", method: "POST" })
      .reply(302, "", { headers: { location: "https://elsewhere.example.net/" } });
    const response = await client(agent).command("status-get");
    assert.equal(response.statusCode, 302);
  });

  it("retries a 5xx and returns the next success", async () => {
    const agent = mockAgent();
    const attempts: UpstreamAttemptOutcome[] = [];
    agent.get(ORIGIN).intercept({ path: "/", method: "POST" }).reply(503, "busy");
    agent.get(ORIGIN).intercept({ path: "/", method: "POST" }).reply(200, OK);
    const response = await client(agent, { attempts }).command("statistic-get-all");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      attempts.map((a) => ("statusCode" in a ? a.statusCode : a.reason)),
      [503, 200],
    );
    assert.ok(attempts.every((a) => a.command === "statistic-get-all"));
  });

  it("retries a network error and classifies a persistent one as network", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: "/", method: "POST" })
      .replyWithError(new Error("connection reset"))
      .persist();
    const attempts: UpstreamAttemptOutcome[] = [];
    await assert.rejects(
      () => client(agent, { attempts }).command("status-get"),
      (error: unknown) => error instanceof KeaHttpError && error.reason === "network",
    );
    assert.ok(attempts.length > 1, "expected at least one retry");
    assert.ok(attempts.every((a) => "reason" in a && a.reason === "network"));
  });

  it("aborts an over-size body as too_large without retrying, labelled with its status", async () => {
    const agent = mockAgent();
    const attempts: UpstreamAttemptOutcome[] = [];
    agent.get(ORIGIN).intercept({ path: "/", method: "POST" }).reply(200, "x".repeat(4096));
    await assert.rejects(
      () => client(agent, { maxResponseBytes: 1024, attempts }).command("statistic-get-all"),
      (error: unknown) => error instanceof KeaHttpError && error.reason === "too_large",
    );
    assert.deepEqual(
      attempts.map((a) => ("statusCode" in a ? a.statusCode : a.reason)),
      [200],
    );
  });

  it("times out within the wall-clock budget", async () => {
    const agent = mockAgent();
    agent.get(ORIGIN).intercept({ path: "/", method: "POST" }).reply(200, OK).delay(2000);
    const started = performance.now();
    await assert.rejects(
      () => client(agent, { budgetMs: 100, clock: systemClock }).command("status-get"),
      (error: unknown) => error instanceof KeaHttpError && error.reason === "timeout",
    );
    assert.ok(performance.now() - started < 1500, "the budget was not respected");
  });

  it("never exposes the password through the client object", () => {
    const kea = client(mockAgent());
    assert.equal(JSON.stringify(kea).includes("s3cret"), false);
  });
});
