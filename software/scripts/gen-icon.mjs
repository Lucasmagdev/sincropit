// Gera um ícone .ico + .png pro app, do zero, sem dependências externas —
// só zlib (nativo do Node) pra codificar PNG na mão.
// Desenho: fundo escuro arredondado + traço de pulso (tipo osciloscópio),
// combina com o tema do app (accent #e8a33d sobre #101210).

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function dist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby || 1)));
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [16, 18, 16]; // #101210
  const accent = [232, 163, 61]; // #e8a33d
  const radius = size * 0.18;

  // pontos do traço de pulso (coordenadas normalizadas 0-1), estilo osciloscópio
  const wave = [
    [0.10, 0.52], [0.28, 0.52], [0.34, 0.20], [0.40, 0.80],
    [0.46, 0.40], [0.52, 0.52], [0.66, 0.52], [0.90, 0.52],
  ].map(([x, y]) => [x * size, y * size]);

  const thickness = Math.max(2, size * 0.045);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // máscara de cantos arredondados
      const cx = x < radius ? radius : x > size - radius ? size - radius : x;
      const cy = y < radius ? radius : y > size - radius ? size - radius : y;
      const cornerDist = Math.hypot(x - cx, y - cy);
      const inside = (x >= radius && x <= size - radius) || (y >= radius && y <= size - radius) || cornerDist <= radius;

      if (!inside) { rgba[i + 3] = 0; continue; }

      let minD = Infinity;
      for (let s = 0; s < wave.length - 1; s++) {
        const d = dist(x, y, wave[s][0], wave[s][1], wave[s + 1][0], wave[s + 1][1]);
        if (d < minD) minD = d;
      }

      if (minD <= thickness) {
        const edge = Math.max(0, Math.min(1, thickness - minD));
        rgba[i] = accent[0]; rgba[i + 1] = accent[1]; rgba[i + 2] = accent[2];
        rgba[i + 3] = Math.round(255 * Math.min(1, edge));
      } else {
        rgba[i] = bg[0]; rgba[i + 1] = bg[1]; rgba[i + 2] = bg[2];
        rgba[i + 3] = 255;
      }
    }
  }
  return rgba;
}

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const imageDatas = [];
  let offset = 6 + 16 * count;

  for (const { size, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    imageDatas.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageDatas]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = sizes.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));

const buildDir = path.join(__dirname, "..", "build");
mkdirSync(buildDir, { recursive: true });
writeFileSync(path.join(buildDir, "icon.ico"), buildIco(pngBuffers));

const publicDir = path.join(__dirname, "..", "public");
mkdirSync(publicDir, { recursive: true });
writeFileSync(path.join(publicDir, "icon.png"), pngBuffers.find((p) => p.size === 256).png);

console.log("gerado: build/icon.ico e public/icon.png");
