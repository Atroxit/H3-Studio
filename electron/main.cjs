// Electron main process for H3 Studio.
//
// The window is a plain web page served by the app's own local server, which runs as a
// child process here. Nothing in the renderer can reach Node: context isolation stays on,
// node integration off, and the only channel is HTTP on loopback.

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'server', 'main.cjs');
const WEB_ROOT = path.join(PROJECT_ROOT, 'dist', 'web');
const PORT_FIRST = 4317;
const PORT_TRIES = 40;
const HEALTH_TIMEOUT_MS = 30_000;

let serverProcess = null;
let mainWindow = null;
let serverLog = [];

function trimLog(line) {
  serverLog.push(line);
  if (serverLog.length > 40) serverLog.shift();
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let port = PORT_FIRST; port < PORT_FIRST + PORT_TRIES; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port between ${PORT_FIRST} and ${PORT_FIRST + PORT_TRIES - 1}.`);
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthCheck(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function startServer(port, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      H3_PORT: String(port),
      H3_DATA_DIR: dataDir,
      H3_WEB_ROOT: WEB_ROOT,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim().length > 0) { trimLog(line); console.log(`[server] ${line}`); }
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim().length > 0) { trimLog(line); console.error(`[server] ${line}`); }
    }
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null && !app.isQuitting) {
      const detail = serverLog.slice(-12).join('\n') || 'no output captured';
      dialog.showErrorBox('H3 Studio stopped', `The local server exited with code ${code} (${signal ?? 'no signal'}).\n\n${detail}`);
    }
  });
  return child;
}

function stopServer() {
  if (serverProcess === null) return;
  const child = serverProcess;
  serverProcess = null;
  try { child.kill(); } catch { /* already gone */ }
}

function createWindow(port) {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0a0c',
    title: 'H3 Studio',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Evidence hook: H3_CAPTURE_PATH renders the real window to a PNG and exits. Used to
  // verify the desktop shell visually without capturing the whole screen.
  const capturePath = process.env.H3_CAPTURE_PATH;
  if (capturePath && capturePath.trim().length > 0) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await window.webContents.capturePage();
          require('node:fs').writeFileSync(capturePath, image.toPNG());
          console.log(`[capture] wrote ${capturePath}`);
        } catch (error) {
          console.error(`[capture] failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        app.isQuitting = true;
        stopServer();
        app.quit();
      }, 1500);
    });
  }

  // Nothing may navigate the app window away from the local server; links open outside.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void window.loadURL(`http://127.0.0.1:${port}/`);
  return window;
}

async function boot() {
  if (!require('node:fs').existsSync(SERVER_ENTRY)) {
    throw new Error(`The server bundle is missing at ${SERVER_ENTRY}. Run: npm run desktop:build`);
  }
  const dataDir = path.join(app.getPath('userData'), 'library');
  const port = await pickPort();
  serverProcess = startServer(port, dataDir);
  const healthy = await waitForHealth(port);
  if (!healthy) {
    const detail = serverLog.slice(-12).join('\n') || 'no output captured';
    throw new Error(`The local server did not become healthy on port ${port}.\n\n${detail}`);
  }
  mainWindow = createWindow(port);
  mainWindow.on('closed', () => { mainWindow = null; });
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      await boot();
    } catch (error) {
      dialog.showErrorBox('H3 Studio could not start', error instanceof Error ? error.message : String(error));
      app.isQuitting = true;
      stopServer();
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });

  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('window-all-closed', () => { stopServer(); app.quit(); });
  app.on('quit', stopServer);
}
