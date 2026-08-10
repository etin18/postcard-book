/**
 * 產生 PWA 圖示（不依賴任何套件，純 Node 手寫 PNG）
 * 執行：node scripts/make-icons.js
 *
 * 圖案：橘底 + 白色明信片，右上角一張郵票、左邊幾行地址。
 * 內容都落在中心安全區內，所以可以當 maskable icon 用。
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = [0xd4, 0x47, 0x7f]; // 主色玫瑰粉（與 App 的 --accent 一致）
const FG = [0xff, 0xff, 0xff]; // 明信片白

/* ---------- PNG 編碼 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** pixels: Buffer，size*size*4 的 RGBA */
function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每條掃描線前面加一個 filter byte（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 圖案 ---------- */

/**
 * 圓角矩形的內部判斷：把點夾到內縮矩形上，再看離不離得夠近。
 * 座標都用畫布比例表示，所以任何尺寸都畫得出同一個圖案。
 */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 明信片本體 */
function isCard(px, py, S) {
  return inRoundRect(px, py, 0.16 * S, 0.29 * S, 0.84 * S, 0.71 * S, 0.035 * S);
}

/** 挖空的部分：右上角郵票，左邊四行地址 */
function isCutout(px, py, S) {
  // 郵票
  if (inRoundRect(px, py, 0.655 * S, 0.345 * S, 0.795 * S, 0.475 * S, 0.012 * S)) {
    return true;
  }

  // 地址行：{ 起始 y, 寬度 }，都從左邊 0.215 開始
  const lines = [
    { y: 0.360, w: 0.290 },
    { y: 0.430, w: 0.340 },
    { y: 0.500, w: 0.230 },
    { y: 0.570, w: 0.415 },
  ];
  const xStart = 0.215 * S;
  const thickness = 0.036 * S;

  for (const line of lines) {
    const y0 = line.y * S;
    if (py >= y0 && py <= y0 + thickness &&
        px >= xStart && px <= xStart + line.w * S) {
      return true;
    }
  }
  return false;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const SS = 3; // 每軸 3x 超取樣，邊緣才不會鋸齒

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      const total = SS * SS;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (isCard(px, py, size) && !isCutout(px, py, size)) hits++;
        }
      }

      const t = hits / total; // 0 = 純背景，1 = 純明信片
      const i = (y * size + x) * 4;
      pixels[i]     = Math.round(BG[0] + (FG[0] - BG[0]) * t);
      pixels[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t);
      pixels[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/* ---------- 輸出 ---------- */

const outDir = path.join(__dirname, '..', 'www', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`已產生 ${path.relative(process.cwd(), file)}  (${size}x${size})`);
}
