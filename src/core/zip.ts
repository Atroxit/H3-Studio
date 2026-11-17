import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
const STORE_METHOD = 0;
/** Fixed MS-DOS timestamp (1980-01-01 00:00): identical entries must give identical bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UTF8_NAME_FLAG = 0x0800;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

interface PreparedEntry {
  nameBytes: Uint8Array;
  bytes: Uint8Array;
  crc: number;
  flags: number;
}

function prepare(entry: ZipEntry): PreparedEntry {
  const nameBytes = new TextEncoder().encode(entry.name);
  const asciiOnly = nameBytes.every((byte) => byte < 0x80);
  return {
    nameBytes,
    bytes: entry.bytes,
    crc: crc32(entry.bytes) >>> 0,
    flags: asciiOnly ? 0 : UTF8_NAME_FLAG,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function localHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(LOCAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, entry.flags, true);
  view.setUint16(8, STORE_METHOD, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.bytes.length, true);
  view.setUint32(22, entry.bytes.length, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, 0, true);
  return header;
}

function centralHeader(entry: PreparedEntry, localOffset: number): Uint8Array {
  const header = new Uint8Array(CENTRAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, entry.flags, true);
  view.setUint16(10, STORE_METHOD, true);
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.bytes.length, true);
  view.setUint32(24, entry.bytes.length, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  return header;
}

function endRecord(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  const record = new Uint8Array(END_RECORD_SIZE);
  const view = new DataView(record.buffer);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

/** Store-method ZIP writer: no compression, so the payload bytes are copied verbatim. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const prepared = prepare(entry);
    const header = localHeader(prepared);
    locals.push(header, prepared.nameBytes, prepared.bytes);
    centrals.push(centralHeader(prepared, offset), prepared.nameBytes);
    offset += header.length + prepared.nameBytes.length + prepared.bytes.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  return concat([
    ...locals,
    ...centrals,
    endRecord(entries.length, centralSize, offset),
  ]);
}
