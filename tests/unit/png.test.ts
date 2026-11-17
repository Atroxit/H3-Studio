import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, readPngSize, synthImage } from '../../src/core/png';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SIGNATURE_LENGTH = PNG_SIGNATURE.length;

interface Chunk {
  type: string;
  data: Uint8Array;
}

function parseChunks(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let offset = SIGNATURE_LENGTH;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    const start = offset + 8;
    chunks.push({ type, data: bytes.subarray(start, start + length) });
    offset = start + length + 4;
  }
  return chunks;
}

function chunksOfType(chunks: Chunk[], type: string): Chunk[] {
  return chunks.filter((chunk) => chunk.type === type);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('encodePng', () => {
  it('starts the encoded bytes with the PNG signature', () => {
    const bytes = encodePng(1, 1, new Uint8Array([10, 20, 30]));
    expect(Array.from(bytes.subarray(0, SIGNATURE_LENGTH))).toEqual(PNG_SIGNATURE);
  });

  it('writes IHDR, IDAT and IEND and decodes a 1x1 image to the right size and pixels', () => {
    const bytes = encodePng(1, 1, new Uint8Array([12, 34, 56]));
    const chunks = parseChunks(bytes);

    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunksOfType(chunks, 'IHDR')[0];
    if (!ihdr) {
      throw new Error('no IHDR chunk');
    }
    expect(Array.from(ihdr.data)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    expect(chunksOfType(chunks, 'IEND')[0]?.data).toHaveLength(0);

    const idat = concat(chunksOfType(chunks, 'IDAT').map((chunk) => chunk.data));
    // One scanline: filter byte 0 then the single RGB pixel.
    expect(Array.from(inflateSync(idat))).toEqual([0, 12, 34, 56]);

    expect(readPngSize(bytes)).toEqual({ width: 1, height: 1 });
  });

  it('rejects rows of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(11))).toThrow(/12 bytes/);
  });
});

describe('readPngSize', () => {
  it('round trips the size for three images', () => {
    const sizes = [
      { width: 8, height: 8 },
      { width: 64, height: 40 },
      { width: 120, height: 72 },
    ];
    for (const size of sizes) {
      const png = synthImage({ ...size, seed: 3, label: 'size round trip' });
      expect(readPngSize(png)).toEqual(size);
    }
  });

  it('throws when the buffer is not a PNG', () => {
    expect(() => readPngSize(new Uint8Array(32))).toThrow(/signature/);
  });
});

describe('synthImage', () => {
  it('is deterministic for the same seed and label', () => {
    const first = synthImage({ width: 24, height: 24, seed: 11, label: 'quiet lake' });
    const second = synthImage({ width: 24, height: 24, seed: 11, label: 'quiet lake' });
    expect(digest(second)).toBe(digest(first));
  });

  it('differs across seeds', () => {
    const first = synthImage({ width: 24, height: 24, seed: 1, label: 'quiet lake' });
    const second = synthImage({ width: 24, height: 24, seed: 2, label: 'quiet lake' });
    expect(digest(second)).not.toBe(digest(first));
  });

  it('differs across labels', () => {
    const first = synthImage({ width: 24, height: 24, seed: 1, label: 'quiet lake' });
    const second = synthImage({ width: 24, height: 24, seed: 1, label: 'loud sea' });
    expect(digest(second)).not.toBe(digest(first));
  });
});
