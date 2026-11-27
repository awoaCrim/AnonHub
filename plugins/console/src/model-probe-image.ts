import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

// A self-contained challenge avoids external image URLs or leaking its answer in prompt text.
const DIGITS = [
  ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  ["11111", "00001", "00001", "11111", "00001", "00001", "11111"],
  ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
  ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
];

export function imageProbeChallenge() {
  const answer = String(randomInt(100000, 1000000)),
    scale = 8,
    margin = 2;
  const width = (answer.length * 6 - 1 + margin * 2) * scale,
    height = (7 + margin * 2) * scale;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0; // PNG filter: none.
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / scale) - margin,
        gy = Math.floor(y / scale) - margin;
      const index = Math.floor(gx / 6),
        col = gx % 6;
      if (gy < 0 || gy >= 7 || index < 0 || index >= answer.length || col < 0 || col >= 5) continue;
      if (DIGITS[Number(answer[index])]![gy]![col] === "1") pixels.fill(0, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const image = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { answer, image };
}

function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, payload, tail]);
}
