// Managed local backends. A provider may name a command the studio runs itself, so a
// ComfyUI server is already up when the first generation is queued, and is stopped
// again when the studio quits instead of being left holding the GPU.
//
// Nothing here knows how a backend is configured beyond its own health check, so any
// local provider can be launched the same way.

import { spawn, type ChildProcess } from 'node:child_process';
import type { ProviderConfig } from '../core/types';

const HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_FOR_HEALTH_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 1500;

/** What one ensureStarted call did, so a caller can tell a spawn from a warm backend. */
export interface ProviderStartResult {
  started: boolean;
  alreadyRunning: boolean;
}

/** What the launcher knows about one provider's managed process right now. */
export type ProviderLauncherStatus = 'idle' | 'starting' | 'running' | 'error';

export interface ProviderLauncher {
  /** Starts the provider's process when its launch config asks for it and it is not up. */
  ensureStarted(config: ProviderConfig): Promise<ProviderStartResult>;
  /** Starts every enabled provider whose launch config is enabled. Never throws. */
  ensureEnabledStarted(): Promise<void>;
  /** Asks running backends to stop their current work, then kills every spawned process. */
  stopAll(): Promise<void>;
  /** The provider ids with a spawned process, so a caller can observe the tracked set. */
  spawnedProviderIds(): string[];
  /** What the launcher is doing for this provider: idle, starting, running or error. */
  statusOf(providerId: string): ProviderLauncherStatus;
  /** The message of the last failed spawn or start, when there is one. */
  lastErrorOf(providerId: string): string | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function baseUrlOf(config: ProviderConfig): string {
  return config.baseUrl.replace(/\/+$/, '');
}

/** ComfyUI stops sampling when it receives this, which is what an abort must do. */
async function interrupt(config: ProviderConfig): Promise<void> {
  try {
    await fetch(`${baseUrlOf(config)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS),
    });
  } catch {
    // A backend that is already gone needs no interrupt.
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    // A launcher process usually starts the real server as a child, so the whole tree
    // goes: killing only the launcher would leave ComfyUI running.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      child.kill();
      resolve();
    });
    killer.on('exit', () => {
      resolve();
    });
  });
}

export function createProviderLauncher(
  getProviders: () => Promise<ProviderConfig[]>,
  checkHealth: (config: ProviderConfig) => Promise<boolean>,
): ProviderLauncher {
  const children = new Map<string, ChildProcess>();
  const inFlight = new Map<string, Promise<ProviderStartResult>>();
  /** The last spawn or start failure per provider, cleared when a new start begins. */
  const errors = new Map<string, string>();

  async function isHealthy(config: ProviderConfig): Promise<boolean> {
    try {
      return await checkHealth(config);
    } catch {
      return false;
    }
  }

  /**
   * Polls until the backend answers, the child exits, or the wait budget runs out.
   * A child that exits early is a failed start, reported by the caller's next health
   * check rather than here.
   */
  async function waitForHealth(config: ProviderConfig, child: ChildProcess, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    const onExit = (): void => {
      exited = true;
    };
    child.once('exit', onExit);
    // A command that could not be spawned never exits, so its error stops the wait too.
    child.once('error', onExit);
    try {
      for (;;) {
        if (exited) return;
        if (await isHealthy(config)) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await wait(Math.min(HEALTH_POLL_INTERVAL_MS, remaining));
      }
    } finally {
      child.off('exit', onExit);
      child.off('error', onExit);
    }
  }

  async function start(config: ProviderConfig): Promise<ProviderStartResult> {
    const launch = config.launch;
    if (launch === undefined || !launch.enabled || launch.command.trim().length === 0) {
      return { started: false, alreadyRunning: false };
    }
    if (await isHealthy(config)) return { started: false, alreadyRunning: true };

    const cwd = launch.cwd !== undefined && launch.cwd.trim().length > 0 ? launch.cwd : undefined;
    // A launch env is how a runtime switch reaches the backend, so it is merged over the
    // studio's own environment instead of replacing it: PATH and friends must survive.
    const env = { ...process.env, ...(launch.env ?? {}) };
    errors.delete(config.id);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args ?? [], {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      errors.set(config.id, messageOf(error));
      throw error;
    }
    // Both pipes are drained: a chatty backend must not block on a full pipe.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('error', (error: Error) => {
      errors.set(config.id, error.message);
      // A spawn that failed never gets an exit event, so it is untracked here.
      if (children.get(config.id) === child) children.delete(config.id);
      console.warn(`h3-studio: provider ${config.id} could not be started: ${error.message}`);
    });
    child.on('exit', () => {
      if (children.get(config.id) === child) children.delete(config.id);
    });
    children.set(config.id, child);

    await waitForHealth(config, child, launch.waitForHealthMs ?? DEFAULT_WAIT_FOR_HEALTH_MS);
    return { started: true, alreadyRunning: false };
  }

  async function ensureStarted(config: ProviderConfig): Promise<ProviderStartResult> {
    const pending = inFlight.get(config.id);
    if (pending !== undefined) return pending;
    const run = start(config);
    inFlight.set(config.id, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(config.id) === run) inFlight.delete(config.id);
    }
  }

  return {
    ensureStarted,

    async ensureEnabledStarted(): Promise<void> {
      let providers: ProviderConfig[];
      try {
        providers = await getProviders();
      } catch (error) {
        console.warn(`h3-studio: could not read providers to start: ${messageOf(error)}`);
        return;
      }
      for (const config of providers) {
        if (config.enabled === false) continue;
        if (config.launch?.enabled !== true) continue;
        try {
          await ensureStarted(config);
        } catch (error) {
          console.warn(`h3-studio: provider ${config.id} did not start: ${messageOf(error)}`);
        }
      }
    },

    async stopAll(): Promise<void> {
      const providers = await getProviders().catch((): ProviderConfig[] => []);
      // A ComfyUI prompt in flight keeps the GPU busy: ask it to stop before killing.
      const running = await Promise.all(
        providers.map(async (config) => {
          if (config.kind !== 'comfyui') return false;
          if (children.has(config.id)) return true;
          return isHealthy(config);
        }),
      );
      await Promise.all(
        providers
          .filter((_config, index) => running[index] === true)
          .map((config) => interrupt(config)),
      );

      const spawned = [...children.values()];
      children.clear();
      await Promise.all(spawned.map((child) => stopChild(child)));
    },

    spawnedProviderIds(): string[] {
      return [...children.keys()];
    },

    statusOf(providerId: string): ProviderLauncherStatus {
      if (inFlight.has(providerId)) return 'starting';
      if (children.has(providerId)) return 'running';
      if (errors.has(providerId)) return 'error';
      return 'idle';
    },

    lastErrorOf(providerId: string): string | undefined {
      return errors.get(providerId);
    },
  };
}
