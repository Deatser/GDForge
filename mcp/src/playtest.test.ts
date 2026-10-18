import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeError } from "./bridge.js";
import { runTest, type TestResult } from "./playtest.js";

const died: TestResult = {
  running: false,
  result: "died",
  x: 245,
  y: 15,
  progressPercent: 40,
  inputsUsed: 1,
  path: "15,15;45,15;",
  objectsNearDeath: [{ uid: 7, id: 8, x: 255, y: 15 }],
};

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
