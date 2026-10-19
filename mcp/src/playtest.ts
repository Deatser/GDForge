// Automated test runs: the mod plays the level with planned inputs and reports how it went.

import type { Bridge } from "./bridge.js";

// One planned press: at a player x (classic, the player only runs right) or at a time
// in seconds since the run started (platformer)
export interface TestInput {
  button?: "jump" | "left" | "right" | undefined;
  x?: number | undefined;
  t?: number | undefined;
  // Where or when the button is let go, in the unit of the press; none is a tap
  release?: number | undefined;
}

// Reply of test.poll once the run has ended
export interface TestResult {
  running: false;
  // ended: the run's duration was up and the player was still alive
  result: "passed" | "ended" | "died" | "stopped" | "timeout";
  // Where the player was when the run ended
  x: number;
  y: number;
  // Seconds of game time the run lasted
  time: number;
  // Towards untilX; absent when the run had no x to reach
  progressPercent?: number;
  inputsUsed: number;
  // "t,x,y;" points along the player's path: seconds since the start, then the position
  path: string;
  objectsNearDeath?: Array<{ uid: number; id: number; x: number; y: number }>;
}

export function checkInputs(inputs: TestInput[] = []): void {
  inputs.forEach((input, index) => {
    const press = input.x ?? input.t;
    if (press === undefined || (input.x !== undefined && input.t !== undefined)) {
      throw new Error(`Input ${index + 1} needs x (a player position) or t (seconds since the start), not both.`);
    }
    if (input.release !== undefined && input.release < press) {
      throw new Error(`Input ${index + 1} is let go before it is pressed: release must not be less than ${press}.`);
    }
  });
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
