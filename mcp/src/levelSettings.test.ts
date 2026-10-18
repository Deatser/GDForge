import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeSettings, encodeSettings, parseColorString } from "./levelSettings.js";

// kS38 of a fresh level in GD 2.2081: BG, G and a custom channel copying channel 3
const COLORS =
  "1_40_2_125_3_255_11_255_12_255_13_255_4_-1_6_1000_7_1_15_1_18_0_8_1|" +
  "1_255_2_255_3_255_11_255_12_255_13_255_4_-1_6_1002_5_1_7_1_15_1_18_0_8_1|" +
  "1_0_2_0_3_0_4_1_6_12_7_0.5_9_3_10_20a0.5a1a1a0_17_1|";

test("reads start colours from the game's colour string", () => {
  const [bg, line, custom] = parseColorString(COLORS);
  assert.deepEqual(bg, { channel: 1000, name: "BG", r: 40, g: 125, b: 255, opacity: 1, blending: false, playerColor: "none" });
  assert.equal(line!.name, "Line");
  assert.equal(line!.blending, true);
  assert.deepEqual(custom, {
    channel: 12,
    r: 0,
    g: 0,
    b: 0,
    opacity: 0.5,
    blending: false,
    playerColor: "P1",
    copyColor: 3,
    copyOpacity: true,
    hsv: { h: 20, s: 0.5, v: 1, absoluteSaturation: true, absoluteBrightness: false },
  });
});

test("decodes the bridge's settings into names", () => {
  const settings = decodeSettings({
    speed: 2,
    mode: 4,
    platformer: true,
    mini: false,
    background: 7,
    saveString: `kS38,${COLORS},kA13,0,kA2,4`,
  });
  assert.equal(settings.speed, "fast");
  assert.equal(settings.mode, "wave");
  assert.equal(settings.gameType, "platformer");
  assert.equal(settings.background, 7);
  assert.equal((settings.colors as unknown[]).length, 3);
  assert.equal("saveString" in settings, false);
});

test("encodes names, hex colours and channel names for the bridge", () => {
  const params = encodeSettings({
    speed: "fastest",
    mode: "swing",
    gameType: "classic",
    mirror: true,
    colors: [
      { channel: "bg", hex: "#287DFF", opacity: 0.8 },
      { channel: 5, r: 10, playerColor: "P2" },
    ],
  });
  assert.deepEqual(params, {
    speed: 4,
    mode: 7,
    platformer: false,
    mirror: true,
    colors: [
      { channel: 1000, r: 40, g: 125, b: 255, opacity: 0.8 },
      { channel: 5, r: 10, playerColor: 2 },
    ],
  });
});

test("rejects channels the settings cannot colour and bad hex", () => {
  assert.throws(() => encodeSettings({ colors: [{ channel: "P1" }] }), /cannot be set/);
  assert.throws(() => encodeSettings({ colors: [{ channel: 1005 }] }), /cannot be set/);
  assert.throws(() => encodeSettings({ colors: [{ channel: 1000, hex: "blue" }] }), /not a colour/);
});
