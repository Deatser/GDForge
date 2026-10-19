// The game's windows, used the way a player uses them: the mod lists the
// controls of whatever is on top and presses them through the game's own callbacks.

import { type Bridge, BridgeError } from "./bridge.js";

// A control by its number from the listing, or by what it says
export type UiTarget = number | string;

// One step, with exactly one of the verbs set
export interface UiAction {
  click?: UiTarget | undefined;
  check?: UiTarget | undefined;
  on?: boolean | undefined;
  type?: UiTarget | undefined;
  text?: string | undefined;
  slide?: UiTarget | undefined;
  value?: number | undefined;
  tap?: [number, number] | undefined;
  drag?: [number, number, number, number] | undefined;
  back?: boolean | undefined;
  wait?: number | undefined;
}

export interface UiControl {
  id: number;
  kind: "button" | "toggle" | "input" | "slider" | "control" | "label";
  // Centre on screen, in points from the bottom left corner
  x: number;
  y: number;
  w?: number;
  h?: number;
  // Words on it, a picture's frame name, or a text field's contents
  text?: string;
  // The label standing next to it
  label?: string;
  // An editor button's name, e.g. editObject
  name?: string;
  on?: boolean;
  // A slider's position, 0 to 1
  value?: number;
  tag?: number;
  nodeId?: string;
  hidden?: boolean;
  disabled?: boolean;
}

// Reply of ui.inspect
export interface UiState {
  layer: string;
  layers: string[];
  screen: { width: number; height: number };
  controls: UiControl[];
  // How many controls matched when more than the limit did
  truncated?: number;
  // A popup that is still growing in, so positions are not final
  settling?: boolean;
}

type BridgeAction = Record<string, unknown> & { action: string };
type Step = { act: BridgeAction } | { wait: number };

const VERBS = ["click", "check", "type", "slide", "tap", "drag", "back", "wait"] as const;

// One action as the bridge takes it, or a pause between actions.
export function toStep(action: UiAction, index: number): Step {
  const verbs = VERBS.filter((verb) => action[verb] !== undefined);
  if (verbs.length !== 1) {
    throw new Error(`Action ${index + 1} needs exactly one of ${VERBS.join(", ")}, not ${verbs.join(" and ") || "none"}.`);
  }
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`Action ${index + 1} needs ${what}.`);
    return value;
  };
  switch (verbs[0]!) {
    case "click":
      return { act: { action: "click", target: action.click } };
    case "check":
      return { act: { action: "check", target: action.check, on: need(action.on, "on: true or false") } };
    case "type":
      return { act: { action: "type", target: action.type, text: need(action.text, "the text to type") } };
    case "slide":
      return { act: { action: "slide", target: action.slide, value: need(action.value, "a value from 0 to 1") } };
    case "tap": {
      const [x, y] = action.tap!;
      return { act: { action: "tap", x, y } };
    }
    case "drag": {
      const [x, y, toX, toY] = action.drag!;
      return { act: { action: "drag", x, y, toX, toY } };
    }
    case "back":
      return { act: { action: "back" } };
    case "wait":
      return { wait: action.wait! };
  }
}

export function formatControl(control: UiControl): string {
  const parts = [`#${control.id}`, control.kind];
  if (control.kind === "toggle") parts.push(control.on ? "on" : "off");
  if (control.kind === "slider" && control.value !== undefined) parts.push(String(control.value));
  if (control.text !== undefined || control.kind === "input") parts.push(JSON.stringify(control.text ?? ""));
  if (control.label !== undefined) parts.push(`label ${JSON.stringify(control.label)}`);
  if (control.name !== undefined) parts.push(`name ${control.name}`);
  parts.push(`at ${control.x},${control.y}`);
  if (control.kind === "control" && control.w !== undefined) parts.push(`size ${control.w}x${control.h}`);
  if (control.tag !== undefined) parts.push(`tag ${control.tag}`);
  if (control.nodeId !== undefined) parts.push(`node ${control.nodeId}`);
  if (control.hidden) parts.push("hidden");
  if (control.disabled) parts.push("disabled");
  return parts.join(" ");
}

export function formatUi(state: UiState): string {
  const lines = [
    `${state.layer} (layers ${state.layers.join(" > ")}; screen ${state.screen.width}x${state.screen.height} points from the bottom left)`,
    ...state.controls.map(formatControl),
  ];
  if (state.truncated) lines.push(`...and ${state.truncated - state.controls.length} more; narrow the list with filter`);
  return lines.join("\n");
}

function describeDone(step: BridgeAction, result: Record<string, unknown>): string {
  const target = result["id"] !== undefined ? `#${result["id"]}` : "";
  switch (step.action) {
    case "check":
      return `check ${target} ${step["on"] ? "on" : "off"}${result["changed"] ? "" : " (already)"}`;
    case "type":
      return `type ${target} ${JSON.stringify(result["text"])}`;
    case "slide":
      return `slide ${target} ${result["value"]}`;
    case "tap":
      return `tap ${step["x"]},${step["y"]}`;
    case "drag":
      return `drag ${step["x"]},${step["y"]} to ${step["toX"]},${step["toY"]}`;
    default:
      return `${step.action} ${target}`.trim();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The window on top once it has finished opening. Right after a click the
// game may still be switching screens, so a busy game is asked again.
export async function settledUi(bridge: Pick<Bridge, "call">, params: Record<string, unknown>, pollMs = 100): Promise<UiState> {
  for (let attempt = 0; ; attempt++) {
    try {
      const state = await bridge.call<UiState>("ui.inspect", params);
      if (!state.settling || attempt >= 15) return state;
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "busy" || attempt >= 30) throw error;
    }
    await sleep(pollMs);
  }
}

// Runs the actions in order, one game frame or more apart like a player's
// clicks, and lists the window on top afterwards.
export async function runUi(
  bridge: Pick<Bridge, "call">,
  actions: UiAction[],
  listing: Record<string, unknown>,
  pollMs = 100,
): Promise<string> {
  // A malformed list fails before anything is pressed
  const steps = actions.map(toStep);
  const done: string[] = [];
  for (const [index, step] of steps.entries()) {
    if ("wait" in step) {
      await sleep(step.wait * 1000);
      done.push(`wait ${step.wait}`);
      continue;
    }
    const { act } = step;
    // Touches land where the window is drawn, so it must have finished growing in
    if (act.action === "tap" || act.action === "drag") await settledUi(bridge, { limit: 1 }, pollMs);
    try {
      done.push(describeDone(act, await bridge.call<Record<string, unknown>>("ui.act", act)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = await settledUi(bridge, listing, pollMs).catch(() => undefined);
      const summary = done.length ? `Done: ${done.join("; ")}.\n` : "";
      throw new Error(`${summary}Action ${index + 1} failed: ${message}${state ? `\n\n${formatUi(state)}` : ""}`);
    }
  }
  const state = await settledUi(bridge, listing, pollMs);
  return (done.length ? `Done: ${done.join("; ")}.\n\n` : "") + formatUi(state);
}
