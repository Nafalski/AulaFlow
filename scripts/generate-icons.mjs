/**
 * Gera os ícones PNG provisórios da PWA.
 *
 * Escrito à mão, sem dependências de imagem: um PNG é uma assinatura, um
 * cabeçalho, os píxeis comprimidos com zlib (que o Node já traz) e um
 * terminador. Acrescentar `sharp` ou `canvas` ao projeto para desenhar dois
 * quadrados seria pagar dezenas de megabytes por isto.
 *
 * O desenho é o mesmo do logótipo: fundo teal, onda branca, sol coral.
 * Provisório, como o requisito pede — quando houver identidade visual a sério,
 * substituem-se os ficheiros em `public/`.
 *
 *     node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const TEAL = [0x0e, 0x7c, 0x86];
const CORAL = [0xef, 0x6c, 0x33];
const WHITE = [0xff, 0xff, 0xff];

// ── CRC32, exigido em cada chunk do PNG ──────────────────────────────────────

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** `pixels` é uma função (x, y) → [r, g, b, a]. */
function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filtro "none" nesta linha
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  // 10..12 = compressão, filtro e entrelaçamento, todos no modo padrão

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── O desenho ────────────────────────────────────────────────────────────────

/**
 * @param size  lado do ícone em píxeis
 * @param padded `true` para o ícone "maskable", que precisa de margem: o
 *   Android recorta-o em círculo e sem folga cortaria a onda.
 * @param opaque mantém todo o fundo preenchido. Ícones maskable e Apple devem
 *   deixar o sistema aplicar a máscara, sem recortes transparentes próprios.
 */
function draw(size, padded, opaque) {
  const inset = padded ? size * 0.1 : 0;
  const box = size - inset * 2;
  const radius = box * 0.22;

  return (x, y) => {
    const px = x - inset;
    const py = y - inset;

    if (px < 0 || py < 0 || px >= box || py >= box) return [...TEAL, 255];

    // Nos ícones normais, os cantos arredondados podem ser transparentes. Nos
    // maskable e Apple, o sistema operativo aplica a máscara e o fundo fica
    // opaco para não aparecerem recortes com uma cor escolhida pelo launcher.
    const cx = Math.min(Math.max(px, radius), box - radius);
    const cy = Math.min(Math.max(py, radius), box - radius);
    if (Math.hypot(px - cx, py - cy) > radius) {
      return opaque ? [...TEAL, 255] : [0, 0, 0, 0];
    }

    const u = px / box;
    const v = py / box;

    // Sol coral, em cima à direita.
    if (Math.hypot(u - 0.7, v - 0.31) < 0.1) return [...CORAL, 255];

    // Onda branca a atravessar o meio.
    const wave = 0.6 + Math.sin(u * Math.PI * 2.2) * 0.06;
    if (Math.abs(v - wave) < 0.055) return [...WHITE, 255];

    return [...TEAL, 255];
  };
}

const ICONS = [
  { file: "icon-192.png", size: 192, padded: false, opaque: false },
  { file: "icon-512.png", size: 512, padded: false, opaque: false },
  { file: "icon-maskable-512.png", size: 512, padded: true, opaque: true },
  { file: "apple-touch-icon.png", size: 180, padded: false, opaque: true },
];

for (const { file, size, padded, opaque } of ICONS) {
  const png = encodePng(size, draw(size, padded, opaque));
  writeFileSync(join(PUBLIC, file), png);
  console.log(`  ${file.padEnd(26)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log("\nÍcones provisórios gerados em public/.");
