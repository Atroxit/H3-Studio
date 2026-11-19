// Launches the desktop shell.
//
// ELECTRON_RUN_AS_NODE is deleted deliberately: when this is run from inside another
// Electron based tool, that variable is already set in the environment, and Electron then
// starts as plain Node, which makes require('electron') return the package shim instead of
// the app API. Clearing it means the launcher behaves the same everywhere.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

if (!existsSync(path.join(root, 'dist', 'server', 'main.cjs'))) {
  console.error('The server bundle is missing. Run: npm run desktop:build');
  process.exit(1);
}

/** The electron package exports the path to its binary when required from Node. */
const electronBinary = require('electron');
if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
  console.error('Electron is not installed. Run: npm install');
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'electron_run_as_node') {
    delete env[key];
  }
}

const child = spawn(electronBinary, [root, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });

child.on('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron terminated by signal ${signal}.`);
    process.exit(1);
  }
  if (typeof code === 'number' && code !== 0) {
    const hex = '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
    console.error(`Electron exited with code ${code} (${hex}).`);
    process.exit(code);
  }
  process.exit(0);
});
