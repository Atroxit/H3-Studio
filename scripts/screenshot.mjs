#!/usr/bin/env node
// Renders a page with the installed Edge browser in headless mode and writes a PNG.
// No dependencies: Edge does the rendering, this script only finds it, passes the
// flags that make the capture deterministic, and checks the file it got back.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const WIDTH = 1440;
const HEIGHT = 1000;
// Virtual time advanced after load, so timers and late paints land in the capture.
const SETTLE_MS = 3000;
const TIMEOUT_MS = 60_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const USAGE = [
  'Usage: node scripts/screenshot.mjs <url> <output.png>',
  '',
  `Renders <url> in headless Edge at ${WIDTH} by ${HEIGHT} and writes <output.png>.`,
  '',
  'Environment:',
  '  H3_EDGE_PATH  Full path to msedge.exe when Edge is installed outside Program Files.',
].join('\n');

function fail(message) {
  process.stderr.write(`[screenshot] ${message}\n`);
  process.exit(1);
}

function usageError(message) {
  process.stderr.write(`[screenshot] ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (argv.length !== 2) {
  usageError(`Expected a URL and an output path, received ${argv.length} argument(s).`);
}

const [url, outputArgument] = argv;

let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  usageError(`Not a URL: ${url}`);
}
if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
  usageError(`Unsupported URL scheme "${parsedUrl.protocol}". Use http, https or file.`);
}

const outputPath = path.resolve(outputArgument);
const outputDir = path.dirname(outputPath);
if (!existsSync(outputDir)) {
  fail(`Output directory does not exist: ${outputDir}`);
}

/** Edge lives in Program Files on a default install, and in the 32 bit tree on 64 bit Windows. */
function edgeCandidates() {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue;
    const candidate = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (!seen.has(candidate)) seen.add(candidate);
  }
  return [...seen];
}

function resolveEdge() {
  const override = process.env.H3_EDGE_PATH;
  if (typeof override === 'string' && override.trim() !== '') {
    const fromOverride = path.resolve(override.trim());
    if (existsSync(fromOverride)) return fromOverride;
    fail(`H3_EDGE_PATH is set to ${fromOverride}, which does not exist.`);
  }
  for (const candidate of edgeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  fail(
    [
      'Microsoft Edge was not found. Looked in:',
      ...edgeCandidates().map((candidate) => `  ${candidate}`),
      'Install Edge, or set H3_EDGE_PATH to the full path of msedge.exe.',
    ].join('\n[screenshot] '),
  );
  return '';
}

/** Width and height from the IHDR chunk, so a truncated or wrong image is caught here. */
function readPngSize(bytes) {
  if (bytes.length < 24) fail('Edge wrote a file that is too short to be a PNG.');
  for (const [index, expected] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== expected) fail('Edge wrote a file that is not a PNG.');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

const edgePath = resolveEdge();
// A file from an earlier run must not be mistaken for this run's output.
rmSync(outputPath, { force: true });
const profileDir = mkdtempSync(path.join(tmpdir(), 'h3-screenshot-'));

let exitCode = null;
let exitSignal = null;
let stderrText = '';

try {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    `--virtual-time-budget=${SETTLE_MS}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profileDir}`,
    `--screenshot=${outputPath}`,
    parsedUrl.href,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(edgePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      reject(new Error(`Edge did not finish within ${TIMEOUT_MS} ms.`));
    }, TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrText += chunk;
      if (stderrText.length > 4000) stderrText = stderrText.slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${edgePath}: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
} catch (error) {
  rmSync(profileDir, { recursive: true, force: true });
  fail(error instanceof Error ? error.message : String(error));
}

rmSync(profileDir, { recursive: true, force: true });

if (exitCode !== 0) {
  const how = exitCode === null ? `signal ${exitSignal ?? 'unknown'}` : `code ${exitCode}`;
  fail(`Edge exited with ${how}.\n[screenshot] ${stderrText.trim() || 'No output from Edge.'}`);
}

if (!existsSync(outputPath)) {
  fail(`Edge finished but wrote no file at ${outputPath}.`);
}

const bytes = readFileSync(outputPath);
const size = readPngSize(bytes);
if (size.width !== WIDTH || size.height !== HEIGHT) {
  fail(`Expected a ${WIDTH} by ${HEIGHT} PNG, received ${size.width} by ${size.height}.`);
}

process.stdout.write(
  `[screenshot] wrote ${outputPath} (${size.width}x${size.height}, ${statSync(outputPath).size} bytes) from ${parsedUrl.href}\n`,
);
