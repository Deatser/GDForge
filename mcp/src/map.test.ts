import assert from "node:assert/strict";
import { test } from "node:test";

import { mapChar, renderMap } from "./map.js";

test("draws gameplay objects and skips the rest", () => {
  assert.equal(mapChar({ id: 1, x: 0, y: 0 }), "#");
  assert.equal(mapChar({ id: 8, x: 0, y: 0 }), "^");
  assert.equal(mapChar({ id: 36, x: 0, y: 0 }), "o");
  assert.equal(mapChar({ id: 12, x: 0, y: 0 }), "P");
  assert.equal(mapChar({ id: 901, x: 0, y: 0 }), undefined);
  assert.equal(mapChar({ id: 1, x: 0, y: 0, noTouch: true }), undefined);
});

test("renders rows top first above the ground line", () => {
  const map = renderMap(
    [
      { id: 1, x: 15, y: 15 },
      { id: 1, x: 45, y: 15 },
      { id: 8, x: 75, y: 15 },
      { id: 36, x: 45, y: 75 },
      // a spike wins over a block in the same cell
      { id: 1, x: 105, y: 15 },
      { id: 8, x: 110, y: 20 },
    ],
    0,
    0,
    4,
    3,
  );
  assert.equal(map, ["   75|.o..", "   45|....", "   15|##^^", "     |===="].join("\n"));
});
