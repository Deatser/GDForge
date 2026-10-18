// Minimal PNG encoder for screenshots, so the server needs no image library.

import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// RGBA pixels, top row first, to an opaque RGB PNG. "shrink" averages each
// shrink x shrink block of pixels into one.
export function rgbaToPng(rgba: Buffer, width: number, height: number, shrink = 1): Buffer {
  const outWidth = Math.floor(width / shrink);
  const outHeight = Math.floor(height / shrink);
  // Each row starts with its filter type, 0 = none
  const raw = Buffer.alloc((outWidth * 3 + 1) * outHeight);
  let offset = 0;
  for (let y = 0; y < outHeight; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < outWidth; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let dy = 0; dy < shrink; dy++) {
          for (let dx = 0; dx < shrink; dx++) {
            sum += rgba[((y * shrink + dy) * width + x * shrink + dx) * 4 + channel]!;
          }
        }
        raw[offset++] = Math.round(sum / (shrink * shrink));
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(outWidth, 0);
  header.writeUInt32BE(outHeight, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
