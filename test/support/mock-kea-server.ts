import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawResponse } from "../../src/http/client.ts";
import { fixture } from "./fake-kea-client.ts";

export interface MockKeaOptions {
  readonly username?: string;
  readonly password?: string;
  readonly replies?: Readonly<Record<string, RawResponse>>;
  // 0.0.0.0 lets a container reach the mock through the host gateway.
  readonly host?: string;
}

export const HEALTHY_DHCP4: Readonly<Record<string, RawResponse>> = {
  "status-get": fixture("ha/hot-standby-primary.json"),
  "version-get": fixture("version/version-get-extended.json"),
  "statistic-get-all": fixture("statistics/dhcp4.json"),
};

// A Kea control socket: POST / with {"command": ...}, basic auth, and the
// array-or-object response envelope. Failures are scripted per command, and
// every request is counted so a test can prove a scrape made none (N2).
export class MockKeaServer {
  readonly #server: Server;
  readonly #expectedAuth: string;
  #replies: Record<string, RawResponse>;
  #down = false;
  requests: string[] = [];

  private constructor(options: MockKeaOptions) {
    const credentials = `${options.username ?? "metrics"}:${options.password ?? "test-password"}`;
    this.#expectedAuth = `Basic ${Buffer.from(credentials).toString("base64")}`;
    this.#replies = { ...(options.replies ?? HEALTHY_DHCP4) };
    this.#server = createServer((req, res) => {
      if (this.#down) {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let command = "";
        try {
          command = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).command);
        } catch {
          command = "<invalid>";
        }
        this.requests.push(command);

        if (req.method !== "POST" || req.url !== "/") {
          res.writeHead(400).end();
          return;
        }
        if (req.headers.authorization !== this.#expectedAuth) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: 401, text: "Unauthorized" }));
          return;
        }
        const reply = this.#replies[command] ?? {
          statusCode: 200,
          body: JSON.stringify([{ result: 2, text: `'${command}' command not supported.` }]),
        };
        res.writeHead(reply.statusCode, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
  }

  static async start(options: MockKeaOptions = {}): Promise<MockKeaServer> {
    const mock = new MockKeaServer(options);
    await new Promise<void>((resolve) =>
      mock.#server.listen(0, options.host ?? "127.0.0.1", resolve),
    );
    return mock;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  set(command: string, reply: RawResponse): void {
    this.#replies[command] = reply;
  }

  setDown(down: boolean): void {
    this.#down = down;
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
