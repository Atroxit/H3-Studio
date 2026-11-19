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

// Wrapped in main() rather than using top level await, so the desktop shell can bundle
// this entry point as CommonJS, which the Electron main process spawns the same way.
async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const port = resolvePort();
  await mkdir(dataDir, { recursive: true });

  const app = createApp({ dataDir });
  const launcher = app.launcher;

  let stopping = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await launcher.stopAll();
    } catch (error) {
      console.warn(`h3-studio: stopping managed backends failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A studio window that is going away must not wait on a stalled socket.
    const forced = setTimeout(() => {
      process.exit(exitCode);
    }, 3000);
    forced.unref();
    server.close(() => {
      clearTimeout(forced);
      process.exit(exitCode);
    });
  };

  // On Windows child.kill() terminates Node immediately without firing SIGTERM, so the
  // Electron shell asks for an orderly shutdown here before falling back to kill().
  app.post('/api/shutdown', (_req, res) => {
    res.status(202).json({ ok: true });
    void shutdown(0);
  });

  const server = app.listen(port, LOOPBACK, () => {
    console.log(`h3-studio: listening on http://${LOOPBACK}:${port} with data in ${dataDir}`);
    // Managed backends start after the socket is open, so a slow model load never
    // delays the studio window, and a backend that fails is only a warning.
    void launcher.ensureEnabledStarted();
  });

  server.on('error', (error: Error) => {
    console.error(`h3-studio: cannot listen on http://${LOOPBACK}:${port}: ${error.message}`);
    process.exitCode = 1;
  });

  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
  // beforeExit has no way to set a code, so it only makes sure nothing is left running.
  process.once('beforeExit', () => {
    if (stopping) return;
    stopping = true;
    void launcher.stopAll();
  });
}

main().catch((error: unknown) => {
  console.error(`h3-studio: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
