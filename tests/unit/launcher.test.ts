// The managed local provider launcher: it starts what a launch config asks for, never
// starts what it does not, and leaves no child process behind. The spawned process here
// is a plain Node script that writes a marker and then idles, so nothing needs a model.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/core/types';
import { createProviderLauncher } from '../../src/server/launcher';

const openDirs: string[] = [];

interface IdleChild {
  scriptPath: string;
  markerPath: string;
  pidPath: string;
}

/** A long lived child that records that it ran and which process id it used. */
async function writeIdleChild(rootDir: string): Promise<IdleChild> {
  const scriptPath = path.join(rootDir, 'idle.cjs');
  const markerPath = path.join(rootDir, 'started.txt');
  const pidPath = path.join(rootDir, 'pid.txt');
  await writeFile(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.argv[2], 'x');",
      'fs.writeFileSync(process.argv[3], String(process.pid));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
  return { scriptPath, markerPath, pidPath };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'h3-launcher-'));
  openDirs.push(directory);
  return directory;
}

function launchConfig(child: IdleChild): ProviderConfig {
  return {
    id: 'comfy-launch',
    kind: 'comfyui',
    label: 'ComfyUI launch',
    // Health is stubbed in every test, so this address is never contacted except by stopAll.
    baseUrl: 'http://127.0.0.1:1',
    launch: {
      enabled: true,
      command: process.execPath,
      args: [child.scriptPath, child.markerPath, child.pidPath],
      cwd: path.dirname(child.scriptPath),
      waitForHealthMs: 120,
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`the spawned process ${pid} is still running`);
}

afterEach(async () => {
  await Promise.all(openDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('provider launcher', () => {
  it('returns at once for a launch config that is off, absent or empty', async () => {
    const checked: string[] = [];
    const launcher = createProviderLauncher(
      async () => [],
      async (config) => {
        checked.push(config.id);
        return false;
      },
    );
    const base: ProviderConfig = { id: 'local', kind: 'a1111', label: 'Local', baseUrl: 'http://127.0.0.1:1' };

    await expect(launcher.ensureStarted(base)).resolves.toEqual({ started: false, alreadyRunning: false });
    await expect(
      launcher.ensureStarted({ ...base, launch: { enabled: false, command: process.execPath } }),
    ).resolves.toEqual({ started: false, alreadyRunning: false });
    await expect(
      launcher.ensureStarted({ ...base, launch: { enabled: true, command: '   ' } }),
    ).resolves.toEqual({ started: false, alreadyRunning: false });

    expect(checked).toEqual([]);
    expect(launcher.spawnedProviderIds()).toEqual([]);
  });

  it('does not spawn a provider that already answers its health check', async () => {
    const rootDir = await tempDir();
    const child = await writeIdleChild(rootDir);
    const config = launchConfig(child);
    const launcher = createProviderLauncher(
      async () => [config],
      async () => true,
    );

    await expect(launcher.ensureStarted(config)).resolves.toEqual({ started: false, alreadyRunning: true });
    expect(launcher.spawnedProviderIds()).toEqual([]);
    // No marker was written, so nothing was ever spawned.
    await expect(readFile(child.markerPath, 'utf8')).rejects.toThrow();

    await launcher.stopAll();
  });

  it('spawns one process for concurrent starts and stops it cleanly', async () => {
    const rootDir = await tempDir();
    const child = await writeIdleChild(rootDir);
    const config = launchConfig(child);
    const launcher = createProviderLauncher(
      async () => [config],
      async () => false,
    );

    const [first, second] = await Promise.all([launcher.ensureStarted(config), launcher.ensureStarted(config)]);
    expect(first).toEqual({ started: true, alreadyRunning: false });
    expect(second).toEqual(first);
    expect(launcher.spawnedProviderIds()).toEqual([config.id]);

    // Both calls shared one spawn, so the child ran exactly once.
    await expect(readFile(child.markerPath, 'utf8')).resolves.toBe('x');
    const pid = Number.parseInt(await readFile(child.pidPath, 'utf8'), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(isAlive(pid)).toBe(true);

    await launcher.stopAll();
    expect(launcher.spawnedProviderIds()).toEqual([]);
    await waitForExit(pid);

    // Nothing is left to stop, so a second call is a quiet no-op.
    await expect(launcher.stopAll()).resolves.toBeUndefined();
  });

  it('merges the launch env into the spawned environment instead of replacing it', async () => {
    const rootDir = await tempDir();
    const scriptPath = path.join(rootDir, 'env.cjs');
    const outPath = path.join(rootDir, 'env.txt');
    await writeFile(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const inherited = (process.env.PATH ?? '').length > 0 ? 'yes' : 'no';",
        "fs.writeFileSync(process.argv[2], String(process.env.H3_TEST_SWITCH) + '|' + inherited);",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      'utf8',
    );
    const config: ProviderConfig = {
      id: 'comfy-env',
      kind: 'comfyui',
      label: 'ComfyUI with env',
      baseUrl: 'http://127.0.0.1:1',
      launch: {
        enabled: true,
        command: process.execPath,
        args: [scriptPath, outPath],
        waitForHealthMs: 120,
        env: { H3_TEST_SWITCH: 'on' },
      },
    };
    const launcher = createProviderLauncher(
      async () => [config],
      async () => false,
    );

    await expect(launcher.ensureStarted(config)).resolves.toEqual({ started: true, alreadyRunning: false });

    const deadline = Date.now() + 5000;
    let written = '';
    while (Date.now() < deadline) {
      try {
        written = await readFile(outPath, 'utf8');
        break;
      } catch {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
    // The provider's own variable is set, and the studio's environment is still there.
    expect(written).toBe('on|yes');

    await launcher.stopAll();
  });

  it('reports idle, starting, running and idle again around one start', async () => {
    const rootDir = await tempDir();
    const child = await writeIdleChild(rootDir);
    const config = launchConfig(child);
    const launcher = createProviderLauncher(
      async () => [config],
      async () => false,
    );

    expect(launcher.statusOf(config.id)).toBe('idle');
    expect(launcher.lastErrorOf(config.id)).toBeUndefined();

    const pending = launcher.ensureStarted(config);
    expect(launcher.statusOf(config.id)).toBe('starting');
    await pending;
    expect(launcher.statusOf(config.id)).toBe('running');

    await launcher.stopAll();
    expect(launcher.statusOf(config.id)).toBe('idle');
  });

  it('reports an error and its message when the command cannot start', async () => {
    const rootDir = await tempDir();
    const config: ProviderConfig = {
      id: 'comfy-broken',
      kind: 'comfyui',
      label: 'Broken backend',
      baseUrl: 'http://127.0.0.1:1',
      launch: {
        enabled: true,
        command: path.join(rootDir, 'a-command-that-does-not-exist'),
        waitForHealthMs: 60,
      },
    };
    const launcher = createProviderLauncher(
      async () => [config],
      async () => false,
    );

    await expect(launcher.ensureStarted(config)).resolves.toEqual({ started: true, alreadyRunning: false });
    expect(launcher.statusOf(config.id)).toBe('error');
    expect(launcher.lastErrorOf(config.id)).toBeTypeOf('string');
    await launcher.stopAll();
  });

  it('starts only the enabled launch configs, and never throws', async () => {
    const rootDir = await tempDir();
    const child = await writeIdleChild(rootDir);
    const enabled = launchConfig(child);
    const disabled: ProviderConfig = {
      ...launchConfig(child),
      id: 'comfy-disabled',
      enabled: false,
    };
    const unmanaged: ProviderConfig = {
      id: 'comfy-unmanaged',
      kind: 'comfyui',
      label: 'ComfyUI unmanaged',
      baseUrl: 'http://127.0.0.1:1',
    };
    const launcher = createProviderLauncher(
      async () => [enabled, disabled, unmanaged],
      async () => false,
    );

    await expect(launcher.ensureEnabledStarted()).resolves.toBeUndefined();
    expect(launcher.spawnedProviderIds()).toEqual([enabled.id]);

    await launcher.stopAll();
    expect(launcher.spawnedProviderIds()).toEqual([]);
  });
});
