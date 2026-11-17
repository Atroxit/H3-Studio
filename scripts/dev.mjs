#!/usr/bin/env node
// Starts the API server and the Vite dev server together for local development.
// Node builtins only, children are spawned directly (no shell), so quoting and
// Ctrl+C behave the same on Windows and elsewhere.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
// How long a child may take to exit after SIGINT before it is killed.
const SHUTDOWN_GRACE_MS = 4000;

const SERVICES = [
  {
    name: 'api',
    entry: path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    args: ['watch', 'src/server/index.ts'],
  },
  {
    name: 'web',
    entry: path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    args: [],
  },
];

const USAGE = [
  'Usage: node scripts/dev.mjs',
  '',
  'Runs the API server with tsx and the Vite dev server together.',
  'Output lines are prefixed with [api] and [web] so the two servers can be told apart.',
  'Ctrl+C stops both. The script exits non-zero if either server stops on its own.',
].join('\n');

function usageError(message) {
  process.stderr.write(`[dev] ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const unknown = argv.filter((argument) => argument !== '--help' && argument !== '-h');
if (unknown.length > 0) usageError(`Unexpected argument: ${unknown[0]}`);

for (const service of SERVICES) {
  if (!existsSync(service.entry)) {
    process.stderr.write(`[dev] Missing ${service.entry}\n[dev] Run "npm install" first.\n`);
    process.exit(1);
  }
}

/** Re-emits a piped child stream one whole line at a time, prefixed with the service name. */
function forwardLines(name, source, target) {
  let buffer = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      target.write(`[${name}] ${line}\n`);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  source.on('end', () => {
    if (buffer !== '') target.write(`[${name}] ${buffer.replace(/\r$/, '')}\n`);
  });
}

const children = [];
let shuttingDown = false;
let finished = false;

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      // On Windows a signal name is ignored and the process is terminated, which is
      // the only reliable way to stop a child that inherited the console.
      child.kill('SIGINT');
    } catch {
      // Already gone.
    }
  }
  const force = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, SHUTDOWN_GRACE_MS);
  force.unref();
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (message !== undefined) process.stderr.write(`${message}\n`);
  stopChildren();
  process.exitCode = code;
}

for (const service of SERVICES) {
  const child = spawn(process.execPath, [service.entry, ...service.args], {
    cwd: ROOT,
    // Stdin stays shared so Ctrl+C reaches the children directly on Windows.
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  forwardLines(service.name, child.stdout, process.stdout);
  forwardLines(service.name, child.stderr, process.stderr);
  child.on('error', (error) => {
    if (shuttingDown) return;
    finish(1, `[dev] could not start ${service.name}: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const how = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
    finish(1, `[dev] ${service.name} stopped unexpectedly (${how}). Stopping the other server.`);
  });
}

process.stdout.write('[dev] API server and web dev server starting. Open http://127.0.0.1:4318 when both are ready.\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[dev] ${signal} received. Stopping both servers.\n`);
    finish(0);
  });
}
