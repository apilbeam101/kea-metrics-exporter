import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RenderGate } from "../../../src/poller/render-gate.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function record(order: string[], label: string) {
  return (text: string): string => {
    order.push(label);
    return text;
  };
}

describe("RenderGate", () => {
  it("shares one in-flight render between concurrent callers", async () => {
    const gate = new RenderGate();
    let produced = 0;
    const pending = deferred<string>();
    const produce = () => {
      produced++;
      return pending.promise;
    };
    const a = gate.render(produce);
    const b = gate.render(produce);
    pending.resolve("text");
    assert.deepEqual(await Promise.all([a, b]), ["text", "text"]);
    assert.equal(produced, 1);
  });

  it("starts a fresh render once the previous one has settled", async () => {
    const gate = new RenderGate();
    let produced = 0;
    await gate.render(async () => `r${++produced}`);
    assert.equal(await gate.render(async () => `r${++produced}`), "r2");
  });

  it("runs an apply only after an in-flight render has finished", async () => {
    const gate = new RenderGate();
    const order: string[] = [];
    const pending = deferred<string>();
    const render = gate.render(() => pending.promise.then(record(order, "render")));
    const apply = gate.exclusive(() => order.push("apply"));
    await Promise.resolve();
    assert.deepEqual(order, []);
    pending.resolve("text");
    await Promise.all([render, apply]);
    assert.deepEqual(order, ["render", "apply"]);
  });

  it("waits out a render that starts while it is already waiting", async () => {
    const gate = new RenderGate();
    const order: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    void gate.render(() => first.promise.then(record(order, "first")));
    const apply = gate.exclusive(() => order.push("apply"));
    first.resolve("1");
    await first.promise;
    void gate.render(() => second.promise.then(record(order, "second")));
    second.resolve("2");
    await apply;
    assert.equal(order.at(-1), "apply");
  });

  it("still applies after a render that failed", async () => {
    const gate = new RenderGate();
    const pending = deferred<string>();
    const render = gate.render(() => pending.promise);
    let applied = false;
    const apply = gate.exclusive(() => {
      applied = true;
    });
    pending.reject(new Error("render failed"));
    await assert.rejects(render);
    await apply;
    assert.equal(applied, true);
  });
});
