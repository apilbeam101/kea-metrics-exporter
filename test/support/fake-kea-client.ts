import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawResponse } from "../../src/http/client.ts";
import type { AllowedCommand } from "../../src/http/command-allowlist.ts";

export type Reply = RawResponse | Error;

export function fixture(path: string, statusCode = 200): RawResponse {
  return {
    statusCode,
    body: readFileSync(join(process.cwd(), "test", "fixtures", path), "utf8"),
  };
}

export function answer(result: number, args?: unknown, text?: string): RawResponse {
  return {
    statusCode: 200,
    body: JSON.stringify([
      {
        result,
        ...(text === undefined ? {} : { text }),
        ...(args === undefined ? {} : { arguments: args }),
      },
    ]),
  };
}

// Each command gets a queue of replies, consumed in order; the last reply
// repeats once the queue is down to one, so a steady state needs one entry.
export class FakeKeaClient {
  readonly calls: AllowedCommand[] = [];
  readonly #replies = new Map<AllowedCommand, Reply[]>();

  constructor(replies: Partial<Record<AllowedCommand, Reply | Reply[]>> = {}) {
    for (const [command, reply] of Object.entries(replies)) {
      this.set(command as AllowedCommand, reply);
    }
  }

  set(command: AllowedCommand, reply: Reply | Reply[]): void {
    this.#replies.set(command, Array.isArray(reply) ? [...reply] : [reply]);
  }

  async command(name: AllowedCommand): Promise<RawResponse> {
    this.calls.push(name);
    const queue = this.#replies.get(name);
    if (queue === undefined || queue.length === 0) throw new Error(`no reply scripted for ${name}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) throw reply;
    return reply as RawResponse;
  }
}
