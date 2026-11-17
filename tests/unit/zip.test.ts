import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/core/zip';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

interface ParsedEntry {
  name: string;
  bytes: Uint8Array;
  method: number;
}

function findEndRecord(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('no end of central directory record');
}

/** Reads a store-method zip back through the central directory, independent of the writer. */
function parseZip(zip: Uint8Array): ParsedEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = findEndRecord(view);
  const entryCount = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ParsedEntry[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`bad central header at ${cursor}`);
    }
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      throw new Error(`bad local header for ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const bytes = zip.slice(dataStart, dataStart + compressedSize);

    expect(compressedSize).toBe(size);
    expect(crc32(bytes) >>> 0).toBe(expectedCrc);
    entries.push({ name, bytes, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('buildZip', () => {
  it('round trips two entries with their names and byte payloads', () => {
    const first = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const second = new TextEncoder().encode('a second payload, longer than the first');
    const zip = buildZip([
      { name: 'images/one.png', bytes: first },
      { name: 'manifest.json', bytes: second },
    ]);

    expect(zip.length).toBeGreaterThan(0);
    const parsed = parseZip(zip);
    expect(parsed.map((entry) => entry.name)).toEqual(['images/one.png', 'manifest.json']);
    expect(Array.from(parsed[0]?.bytes ?? [])).toEqual(Array.from(first));
    expect(Array.from(parsed[1]?.bytes ?? [])).toEqual(Array.from(second));
    expect(parsed.map((entry) => entry.method)).toEqual([0, 0]);
  });

  it('writes an empty archive when there are no entries', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(parseZip(zip)).toEqual([]);
  });

  it('is byte stable for identical input', () => {
    const entries = [{ name: 'one.txt', bytes: new TextEncoder().encode('hello') }];
    expect(Array.from(buildZip(entries))).toEqual(Array.from(buildZip(entries)));
  });

  it('handles a non ascii name', () => {
    const bytes = new TextEncoder().encode('payload');
    const parsed = parseZip(buildZip([{ name: 'caf\u00e9/image.png', bytes }]));
    expect(parsed[0]?.name).toBe('caf\u00e9/image.png');
    expect(Array.from(parsed[0]?.bytes ?? [])).toEqual(Array.from(bytes));
  });
});
