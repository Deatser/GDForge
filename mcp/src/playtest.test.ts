import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeError } from "./bridge.js";
import { checkInputs, runTest, type TestResult } from "./playtest.js";

const died: TestResult = {
  running: false,
  result: "died",
  x: 245,
  y: 15,
  time: 0.75,
  progressPercent: 40,
  inputsUsed: 1,
  path: "0.00,15,15;0.10,45,15;",
  objectsNearDeath: [{ uid: 7, id: 8, x: 255, y: 15 }],
};

test("accepts presses at a position or at a time", () => {
  assert.doesNotThrow(() =>
    checkInputs([
      { x: 200 },
      { x: 300, release: 360 },
      { button: "right", t: 0.5, release: 2 },
      { button: "jump", t: 1.2 },
    ]),
  );
  assert.doesNotThrow(() => checkInputs(undefined));
});

test("rejects an input pressed at both or neither, or let go before it is pressed", () => {
  assert.throws(() => checkInputs([{ x: 100, t: 1 }]), /Input 1 needs x .* or t/);
  assert.throws(() => checkInputs([{ x: 100 }, { button: "left" }]), /Input 2 needs x .* or t/);
  assert.throws(() => checkInputs([{ button: "right", t: 2, release: 1 }]), /Input 1 is let go before/);
});

test("starts a test and polls until it has ended", async () => {
  const calls: Array<[string, unknown]> = [];
  const replies: unknown[] = [{ started: true, untilX: 600 }, { running: true }, { running: true }, died];
  const bridge = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push([method, params]);
      return replies.shift() as T;
    },
  };

  const result = await runTest(bridge, { inputs: [{ x: 200 }], speed: 2 }, 0);

  assert.deepEqual(result, died);
  assert.deepEqual(calls, [
    ["test.start", { inputs: [{ x: 200 }], speed: 2 }],
    ["test.poll", undefined],
    ["test.poll", undefined],
    ["test.poll", undefined],
  ]);
});

test("does not poll when the test could not start", async () => {
  let polls = 0;
  const bridge = {
    async call<T>(method: string): Promise<T> {
      if (method === "test.start") throw new BridgeError("test_running", "A test is already running.");
      polls++;
      return { running: true } as T;
    },
  };

  await assert.rejects(runTest(bridge, {}, 0), /already running/);
  assert.equal(polls, 0);
});
