'use strict';
// Builds the tray icon as PNG in-process (no asset pipeline, no SVG: Electron's
// nativeImage cannot decode SVG data URLs). Template image: black + alpha.
const zlib = require('zlib');
const { nativeImage } = require('electron');

// 16x16 pixel art: two opposing arrows (switch).
const GLYPH = [
  '................',
  '................',
  '.....#..........',
  '....##..........',
  '...############.',
  '....##..........',
  '.....#..........',
  '................',
  '................',
  '..........#.....',
  '..........##....',
  '.############...',
  '..........##....',
  '..........#.....',
  '................',
  '................',
];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Grayscale+alpha 8-bit PNG at the given integer scale.
function png(scale) {
  const size = 16 * scale;
  const raw = Buffer.alloc((size * 2 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 2 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const on = GLYPH[Math.floor(y / scale)][Math.floor(x / scale)] === '#';
      const o = y * (size * 2 + 1) + 1 + x * 2;
      raw[o] = 0; raw[o + 1] = on ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 4; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, gray+alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function trayIcon() {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: png(1) });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: png(2) });
  img.setTemplateImage(true);
  return img;
}

module.exports = { trayIcon, png };
