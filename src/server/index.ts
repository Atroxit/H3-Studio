// The server entry point. Serves the API and, when the web app is built, the studio
// itself on one loopback origin. Nothing here binds a public interface.

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app';

const DEFAULT_PORT = 4317;
const LOOPBACK = '127.0.0.1';
const DATA_DIR_NAME = '.h3-studio';

function resolveDataDir(): string {
  const configured = (process.env.H3_DATA_DIR ?? '').trim();
  if (configured.length > 0) return path.resolve(configured);
  return path.join(os.homedir(), DATA_DIR_NAME);
}

function resolvePort(): number {
  const configured = (process.env.H3_PORT ?? '').trim();
  if (configured.length === 0) return DEFAULT_PORT;
  const parsed = Number.parseInt(configured, 10);
  if (!/^\d+$/.test(configured) || parsed < 1 || parsed > 65_535) {
    console.warn(`h3-studio: ignoring H3_PORT "${configured}", which is not a port number. Using ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return parsed;
}

const dataDir = resolveDataDir();
const port = resolvePort();
await mkdir(dataDir, { recursive: true });

const server = createApp({ dataDir }).listen(port, LOOPBACK, () => {
  console.log(`h3-studio: listening on http://${LOOPBACK}:${port} with data in ${dataDir}`);
});

server.on('error', (error: Error) => {
  console.error(`h3-studio: cannot listen on http://${LOOPBACK}:${port}: ${error.message}`);
  process.exitCode = 1;
});
