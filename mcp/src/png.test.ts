import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

import { rgbaToPng } from "./png.js";

// Pixel rows of the image, without the filter byte that starts each row
function readPng(png: Buffer): { width: number; height: number; rows: number[][] } {
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.toString("ascii", 37, 41), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const rows = [];
  for (let y = 0; y < height; y++) rows.push([...raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1))]);
  return { width, height, rows };
}

test("encodes RGBA pixels as RGB, dropping alpha", () => {
  const rgba = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 128, 10, 20, 30, 255]);
  const { width, height, rows } = readPng(rgbaToPng(rgba, 2, 2));
  assert.deepEqual([width, height], [2, 2]);
  assert.deepEqual(rows, [
    [255, 0, 0, 0, 255, 0],
    [0, 0, 255, 10, 20, 30],
  ]);
});

test("shrinks by averaging blocks of pixels", () => {
  const rgba = Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
  const { width, height, rows } = readPng(rgbaToPng(rgba, 2, 2, 2));
  assert.deepEqual([width, height], [1, 1]);
  assert.deepEqual(rows, [[100, 100, 100]]);
});
