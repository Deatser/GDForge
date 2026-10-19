import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeError } from "./bridge.js";
import { formatControl, formatUi, parseKey, runUi, toStep, type UiState } from "./ui.js";

const popup: UiState = {
  layer: "SetupMoveCommandPopup",
  layers: ["LevelEditorLayer", "SetupMoveCommandPopup"],
  screen: { width: 569, height: 320 },
  controls: [
    { id: 3, kind: "label", x: 284, y: 290, text: "Move Settings" },
    { id: 7, kind: "input", x: 150, y: 200, w: 60, h: 30, text: "30", label: "Move X", tag: 28 },
    { id: 8, kind: "slider", x: 150, y: 175, w: 120, h: 10, value: 0.5, label: "Move X" },
    { id: 9, kind: "toggle", x: 100, y: 60, w: 25, h: 25, on: false, label: "Touch Trigger" },
    { id: 12, kind: "button", x: 284, y: 30, w: 50, h: 30, text: "OK" },
  ],
};

test("turns each action into one bridge call", () => {
  assert.deepEqual(toStep({ click: "OK" }, 0), { act: { action: "click", target: "OK" } });
  assert.deepEqual(toStep({ check: 9, on: true }, 0), { act: { action: "check", target: 9, on: true } });
  assert.deepEqual(toStep({ type: "Move X", text: "60" }, 0), { act: { action: "type", target: "Move X", text: "60" } });
  assert.deepEqual(toStep({ slide: 8, value: 0.25 }, 0), { act: { action: "slide", target: 8, value: 0.25 } });
  assert.deepEqual(toStep({ tap: [10, 20] }, 0), { act: { action: "tap", x: 10, y: 20 } });
  assert.deepEqual(toStep({ drag: [1, 2, 3, 4] }, 0), { act: { action: "drag", x: 1, y: 2, toX: 3, toY: 4 } });
  assert.deepEqual(toStep({ back: true }, 0), { act: { action: "back" } });
  assert.deepEqual(toStep({ wait: 0.5 }, 0), { wait: 0.5 });
});

test("reads keys and combinations", () => {
  assert.deepEqual(parseKey("d"), { code: 0x44, shift: false, ctrl: false, alt: false });
  assert.deepEqual(parseKey("Ctrl+1"), { code: 0x31, shift: false, ctrl: true, alt: false });
  assert.deepEqual(parseKey("alt+shift+space"), { code: 0x20, shift: true, ctrl: false, alt: true });
  assert.equal(parseKey("f12").code, 0x7b);
  assert.throws(() => parseKey("meta+a"), /Unknown modifier "meta"/);
  assert.throws(() => parseKey("pgup"), /Unknown key "pgup"/);
  assert.deepEqual(toStep({ keyDown: "d" }, 0), {
    act: { action: "key", phase: "down", name: "d", code: 0x44, shift: false, ctrl: false, alt: false },
  });
});

test("rejects an action with no verb, two verbs or a missing value", () => {
  assert.throws(() => toStep({}, 0), /Action 1 needs exactly one of .* not none/);
  assert.throws(() => toStep({ click: 1, back: true }, 2), /Action 3 .* not click and back/);
  assert.throws(() => toStep({ check: 9 }, 0), /needs on: true or false/);
  assert.throws(() => toStep({ type: 7 }, 0), /needs the text/);
  assert.throws(() => toStep({ slide: 8 }, 0), /needs a value/);
});

test("lists a window one control per line", () => {
  assert.equal(
    formatUi(popup),
    [
      "SetupMoveCommandPopup (layers LevelEditorLayer > SetupMoveCommandPopup; screen 569x320 points from the bottom left)",
      '#3 label "Move Settings" at 284,290',
      '#7 input "30" label "Move X" at 150,200 tag 28',
      '#8 slider 0.5 label "Move X" at 150,175',
      '#9 toggle off label "Touch Trigger" at 100,60',
      '#12 button "OK" at 284,30',
    ].join("\n"),
  );
  assert.equal(formatControl({ id: 1, kind: "input", x: 0, y: 0 }), '#1 input "" at 0,0');
  assert.equal(
    formatControl({ id: 2, kind: "button", x: 5, y: 6, text: "GJ_infoIcon_001.png", name: "editObject", hidden: true, disabled: true }),
    '#2 button "GJ_infoIcon_001.png" name editObject at 5,6 hidden disabled',
  );
  assert.equal(formatControl({ id: 4, kind: "control", x: 5, y: 6, w: 100, h: 90, text: "CCControlColourPicker" }), '#4 control "CCControlColourPicker" at 5,6 size 100x90');
});

test("runs actions in order and lists the window afterwards", async () => {
  const calls: Array<[string, unknown]> = [];
  const replies: unknown[] = [
    { action: "type", id: 7, text: "60", layer: "SetupMoveCommandPopup" },
    { action: "check", id: 9, changed: true, layer: "SetupMoveCommandPopup" },
    popup,
  ];
  const bridge = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push([method, params]);
      return replies.shift() as T;
    },
  };

  const text = await runUi(bridge, [{ type: "Move X", text: "60" }, { check: 9, on: true }], { filter: "move" }, 0);

  assert.match(text, /^Done: type #7 "60"; check #9 on\.\n\nSetupMoveCommandPopup/);
  assert.deepEqual(calls, [
    ["ui.act", { action: "type", target: "Move X", text: "60" }],
    ["ui.act", { action: "check", target: 9, on: true }],
    ["ui.inspect", { filter: "move" }],
  ]);
});

test("waits for a popup to finish opening before touching it", async () => {
  const calls: string[] = [];
  const replies: unknown[] = [{ ...popup, settling: true }, popup, { action: "tap" }, popup];
  const bridge = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return replies.shift() as T;
    },
  };

  await runUi(bridge, [{ tap: [100, 60] }], {}, 0);

  assert.deepEqual(calls, ["ui.inspect", "ui.inspect", "ui.act", "ui.inspect"]);
});

test("stops at a failed action and shows what is on screen", async () => {
  const calls: string[] = [];
  const bridge = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push(method);
      if (method === "ui.act" && params?.["target"] === "Nope") throw new BridgeError("not_found", 'Nothing on screen says "Nope".');
      return (method === "ui.inspect" ? popup : { action: "click", id: 12 }) as T;
    },
  };

  await assert.rejects(
    runUi(bridge, [{ click: 12 }, { click: "Nope" }, { click: 12 }], {}, 0),
    (error: Error) =>
      /^Done: click #12\.\nAction 2 failed: Nothing on screen says "Nope"\.\n\nSetupMoveCommandPopup/.test(error.message),
  );
  assert.deepEqual(calls, ["ui.act", "ui.act", "ui.inspect"]);
});

test("checks the whole list before pressing anything", async () => {
  let calls = 0;
  const bridge = {
    async call<T>(): Promise<T> {
      calls++;
      return popup as T;
    },
  };

  await assert.rejects(runUi(bridge, [{ click: 12 }, { slide: 8 }], {}, 0), /Action 2 needs a value/);
  assert.equal(calls, 0);
});
