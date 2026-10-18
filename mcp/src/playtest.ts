// Automated test runs: the mod plays the level with planned inputs and reports how it went.

import type { Bridge } from "./bridge.js";

// Reply of test.poll once the run has ended
export interface TestResult {
  running: false;
  result: "passed" | "died" | "stopped" | "timeout";
  // Where the player was when the run ended
  x: number;
  y: number;
  progressPercent: number;
  inputsUsed: number;
  // "x,y;" points along the player's path
  path: string;
  objectsNearDeath?: Array<{ uid: number; id: number; x: number; y: number }>;
}

// A test plays out over many frames, so start it and then ask until it has ended.
// The mod ends the run itself once its timeout is up.
export async function runTest(
  bridge: Pick<Bridge, "call">,
  params: Record<string, unknown>,
  pollMs = 200,
): Promise<TestResult> {
  await bridge.call("test.start", params);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const state = await bridge.call<{ running: true } | TestResult>("test.poll");
    if (!state.running) return state;
  }
}
