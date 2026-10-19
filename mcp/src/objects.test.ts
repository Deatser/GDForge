import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeObject, decodeRaw, encodeObject, patchSaveString } from "./objects.js";

// The save strings below were read back from the game itself.

test("decodes a plain block", () => {
  assert.deepEqual(decodeObject("1,1,2,15,3,15", 3940), { uid: 3940, id: 1, x: 15, y: 15 });
});

test("decodes transforms the way the editor saves them", () => {
  assert.deepEqual(decodeObject("1,1,2,60,3,30,6,90"), { id: 1, x: 60, y: 30, rotation: 90 });
  assert.deepEqual(decodeObject("1,8,2,105,3,15,128,2,129,2"), { id: 8, x: 105, y: 15, scale: 2 });
  assert.deepEqual(decodeObject("1,8,2,105,3,15,128,2,129,0.5"), { id: 8, x: 105, y: 15, scaleX: 2, scaleY: 0.5 });
  assert.deepEqual(decodeObject("1,8,2,165,3,15,4,1"), { id: 8, x: 165, y: 15, flipX: true });
});

test("decodes groups, colours and layering", () => {
  assert.deepEqual(decodeObject("1,1,2,15,3,15,57,1.2,25,7,21,5,24,9"), {
    id: 1,
    x: 15,
    y: 15,
    groups: [1, 2],
    zOrder: 7,
    color1: 5,
    zLayer: "T3",
  });
});

test("names the properties of a trigger by its class", () => {
  // A move trigger: 2 seconds, target group 5, 30 right and 60 up, touch triggered
  const object = decodeObject("1,901,2,300,3,105,10,2,51,5,28,30,29,60,11,1");
  assert.deepEqual(object.props, {
    duration: 2,
    targetGroupID: 5,
    moveOffsetX: 30,
    moveOffsetY: 60,
    touchTriggered: true,
  });
});

test("takes the live position a playtest reports over the saved one", () => {
  assert.deepEqual(decodeRaw([7, "1,1,2,15,3,15", 75.5, 45]), { uid: 7, id: 1, x: 75.5, y: 45 });
  assert.deepEqual(decodeRaw([7, "1,1,2,15,3,15"]), { uid: 7, id: 1, x: 15, y: 15 });
});

test("keeps keys it has no name for", () => {
  // The orb's own default as the game writes it: key 36 has no known name
  assert.deepEqual(decodeObject("1,36,2,165,3,75,11,1,36,1").props, { touchTriggered: true, "36": "1" });
});

test("encodes a new object", () => {
  assert.equal(encodeObject({ id: 1, x: 15, y: 15 }), "1,1,2,15,3,15");
  assert.equal(
    encodeObject({ id: 8, x: 105.5, y: 15, rotation: 180, scale: 2, flipX: true, groups: [3, 4], zLayer: "B1" }),
    "1,8,2,105.5,3,15,6,180,4,1,24,3,128,2,129,2,57,3.4",
  );
});

test("leaves default values out, as the game does", () => {
  assert.equal(
    encodeObject({ id: 1, x: 0, y: 0, rotation: 0, scale: 1, flipX: false, groups: [], zOrder: 0 }),
    "1,1,2,0,3,0",
  );
});

test("encodes trigger properties by name, loosely spelled, or by key", () => {
  const expected = "1,901,2,300,3,105,10,0.5,51,7,11,1";
  const byName = encodeObject({
    id: 901,
    x: 300,
    y: 105,
    props: { duration: 0.5, targetGroupID: 7, touchTriggered: true },
  });
  const loose = encodeObject({
    id: 901,
    x: 300,
    y: 105,
    props: { duration: 0.5, target_group_id: 7, isTouchTriggered: true },
  });
  const byKey = encodeObject({ id: 901, x: 300, y: 105, props: { "10": 0.5, "51": 7, "11": true } });
  assert.equal(byName, expected);
  assert.equal(loose, expected);
  // Same fields; JavaScript just iterates numeric keys in ascending order
  assert.equal(byKey, "1,901,2,300,3,105,10,0.5,11,1,51,7");
});

test("round-trips what it decodes", () => {
  for (const saveString of [
    "1,1,2,15,3,15",
    "1,36,2,165,3,75,11,1,36,1",
    "1,901,2,300,3,105,10,2,51,5,28,30,29,60,11,1",
    "1,1,2,15,3,15,57,1.2,25,7,21,5",
  ]) {
    const { uid: _uid, ...object } = decodeObject(saveString, 1);
    const fields = (s: string) => s.split(",").reduce<string[]>((pairs, v, i, all) => (i % 2 ? pairs : [...pairs, `${v}=${all[i + 1]}`]), []).sort();
    assert.deepEqual(fields(encodeObject(object)), fields(saveString));
  }
});

test("text is stored base64 encoded", () => {
  const saveString = encodeObject({ id: 914, x: 0, y: 0, props: { text: "Hello GD" } });
  assert.equal(saveString, "1,914,2,0,3,0,31,SGVsbG8gR0Q=");
  assert.equal(decodeObject(saveString).props?.text, "Hello GD");
});

test("patches only what was asked", () => {
  const original = "1,1,2,15,3,15,57,1.2,25,7,21,5,999,keep";
  assert.equal(patchSaveString(original, { color1: 9 }), "1,1,2,15,3,15,57,1.2,25,7,21,9,999,keep");
  assert.equal(patchSaveString(original, { addGroups: [3], removeGroups: [1] }), "1,1,2,15,3,15,57,2.3,25,7,21,5,999,keep");
  assert.equal(patchSaveString(original, { groups: null, zOrder: null }), "1,1,2,15,3,15,21,5,999,keep");
  assert.equal(patchSaveString(original, { props: { "999": null } }), "1,1,2,15,3,15,57,1.2,25,7,21,5");
});

test("patching scale replaces the pre-2.2 single scale key", () => {
  assert.equal(patchSaveString("1,1,2,0,3,0,32,2", { scaleX: 3 }), "1,1,2,0,3,0,128,3,129,2");
  assert.equal(patchSaveString("1,1,2,0,3,0,128,3,129,2", { scale: 1 }), "1,1,2,0,3,0");
});

test("keeps the level settings of a Start Pos", () => {
  const startPos = "1,31,2,75,3,15,kA2,1,kA4,2,kA22,1";
  assert.equal(patchSaveString(startPos, { x: 105 }), "1,31,2,105,3,15,kA2,1,kA4,2,kA22,1");
  assert.deepEqual(decodeObject(startPos).props, { kA2: "1", kA4: "2", kA22: "1" });
});

test("rejects input the game would misread", () => {
  assert.throws(() => encodeObject({ id: 999999, x: 0, y: 0 }), /Unknown object ID/);
  assert.throws(() => encodeObject({ id: 1, x: 0, y: 0, groups: [0] }), /Group IDs/);
  assert.throws(() => encodeObject({ id: 1, x: 0, y: 0, groups: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }), /at most 10/);
  assert.throws(() => encodeObject({ id: 1, x: 0, y: 0, zLayer: "front" }), /Unknown zLayer/);
  assert.throws(() => encodeObject({ id: 901, x: 0, y: 0, props: { notAProperty: 1 } }), /Unknown property/);
  assert.throws(() => encodeObject({ id: 901, x: 0, y: 0, props: { targetGroupID: 1.5 } }), /whole number/);
  assert.throws(() => encodeObject({ id: 1, x: 0, y: 0, props: { "9999": "1;1,8" } }), /must not contain/);
});
