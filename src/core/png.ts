import { deflateSync } from 'node:zlib';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS_PER_PIXEL = 3;
const BIT_DEPTH = 8;
const COLOUR_TYPE_TRUECOLOUR = 2;
const COMPRESSION_DEFLATE = 0;
const FILTER_ADAPTIVE = 0;
const INTERLACE_NONE = 0;
const SCANLINE_FILTER_NONE = 0;
const IHDR_LENGTH = 13;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

/** CRC32 as required by the PNG spec: a reflected table driven implementation, no library. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const slot = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[slot] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    typeBytes[i] = type.charCodeAt(i);
  }
  const crc = crc32(concat([typeBytes, data]));
  return concat([u32(data.length), typeBytes, data, u32(crc)]);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`encodePng expects ${name} to be a positive integer, received ${value}`);
  }
}

function buildScanlines(width: number, height: number, rows: Uint8Array): Uint8Array {
  const stride = width * CHANNELS_PER_PIXEL;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    out[target] = SCANLINE_FILTER_NONE;
    out.set(rows.subarray(y * stride, (y + 1) * stride), target + 1);
  }
  return out;
}

function buildIhdr(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(IHDR_LENGTH);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  view.setUint8(8, BIT_DEPTH);
  view.setUint8(9, COLOUR_TYPE_TRUECOLOUR);
  view.setUint8(10, COMPRESSION_DEFLATE);
  view.setUint8(11, FILTER_ADAPTIVE);
  view.setUint8(12, INTERLACE_NONE);
  return ihdr;
}

/** Encode raw RGB rows into a valid PNG. Deterministic: same input, same bytes. */
export function encodePng(width: number, height: number, rows: Uint8Array): Uint8Array {
  assertPositiveInt('width', width);
  assertPositiveInt('height', height);
  const expected = width * height * CHANNELS_PER_PIXEL;
  if (rows.length !== expected) {
    throw new RangeError(
      `encodePng expects ${expected} bytes of packed RGB for ${width}x${height}, received ${rows.length}`,
    );
  }
  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', buildIhdr(width, height)),
    chunk('IDAT', deflateSync(buildScanlines(width, height, rows))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function blend(base: number, band: number, fade: number, shade: number): number {
  return clampByte((base + (band - base) * fade) * shade);
}

interface Palette {
  base: Rgb;
  band: Rgb;
  slope: number;
  origin: number;
  bandWidth: number;
}

/** Every colour and the band geometry come from the seed and label hash, so a run is reproducible and seeds differ. */
function paletteFor(seed: number, label: string, width: number, height: number): Palette {
  const hash = hash32(`${seed}:${label}`);
  return {
    base: {
      r: 24 + (hash & 0x3f),
      g: 24 + ((hash >>> 8) & 0x3f),
      b: 32 + ((hash >>> 16) & 0x5f),
    },
    band: {
      r: 96 + ((hash >>> 5) & 0x7f),
      g: 96 + ((hash >>> 13) & 0x7f),
      b: 96 + ((hash >>> 21) & 0x7f),
    },
    slope: 0.35 + ((hash >>> 27) & 0x0f) / 20,
    origin: hash % height,
    bandWidth: Math.max(1, Math.round(Math.min(width, height) / 6)),
  };
}

/** A deterministic stand-in image: soft gradient plus a band whose colour derives from the prompt hash. */
export function synthImage(input: { width: number; height: number; seed: number; label: string }): Uint8Array {
  const { width, height, seed, label } = input;
  assertPositiveInt('width', width);
  assertPositiveInt('height', height);

  const palette = paletteFor(seed, label, width, height);
  const rows = new Uint8Array(width * height * CHANNELS_PER_PIXEL);
  const xSpan = Math.max(1, width - 1);
  const ySpan = Math.max(1, height - 1);

  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gradient = (x / xSpan + y / ySpan) / 2;
      const distance = Math.abs(y - (palette.origin + palette.slope * x));
      const fade = Math.max(0, 1 - distance / (palette.bandWidth * 2));
      const shade = 0.65 + gradient * 0.7;
      rows[offset] = blend(palette.base.r, palette.band.r, fade, shade);
      rows[offset + 1] = blend(palette.base.g, palette.band.g, fade, shade);
      rows[offset + 2] = blend(palette.base.b, palette.band.b, fade, shade);
      offset += CHANNELS_PER_PIXEL;
    }
  }

  return encodePng(width, height, rows);
}

function chunkTypeAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Read width and height from a PNG buffer. Throws when the buffer is not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } {
  const headerEnd = SIGNATURE.length + 8 + 8;
  if (bytes.length < headerEnd) {
    throw new Error(`readPngSize: buffer is too short to be a PNG (${bytes.length} bytes)`);
  }
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new Error('readPngSize: buffer does not start with the PNG signature');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(SIGNATURE.length, false);
  const type = chunkTypeAt(view, SIGNATURE.length + 4);
  if (type !== 'IHDR' || length !== IHDR_LENGTH) {
    throw new Error(`readPngSize: expected an IHDR chunk first, found ${type} with length ${length}`);
  }
  return {
    width: view.getUint32(SIGNATURE.length + 8, false),
    height: view.getUint32(SIGNATURE.length + 12, false),
  };
}
