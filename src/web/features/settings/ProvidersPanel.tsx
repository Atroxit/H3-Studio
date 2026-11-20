// The Providers tab: one featured provider with the whole form on it, and a balanced grid
// of the others. The featured card owns exactly one enable or disable action, so no card
// ever shows an Enable and a Disable button side by side.

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { ProviderConfig, ProviderKind } from '../../../core/types';
import {
  checkProviderHealth,
  createProvider,
  getProviderStatus,
  updateProvider,
  type ProviderStatus,
  type ProviderUpdateBody,
} from '../../api';
import { Button, Field } from '../../components';
import { H3_IMAGE_TEMPLATE_JSON } from '../../data/h3ImageTemplate';
import { isProviderEnabled, useStudio } from '../../studio';
import {
  describeCapabilityOverride,
  describeError,
  formatEnvLines,
  formatLaunchArguments,
  H3_IMAGE_CAPABILITIES,
  parseEnvLines,
  parseLaunchArguments,
  PROVIDER_KINDS,
  providerKindMeta,
  sameJson,
  savedCapabilityOverride,
  savedTimeoutSeconds,
  savedWorkflowTemplate,
  workflowTemplateProblem,
  WORKFLOW_PLACEHOLDERS,
  type ProviderKindMeta,
} from './helpers';

export interface ProvidersPanelProps {
  /** Called with a provider that was just enabled, so the studio selects it. */
  onProviderEnabled: (saved: ProviderConfig) => void;
}

const STATUS_LABELS: Readonly<Record<ProviderStatus['state'], string>> = {
  ready: 'Ready',
  starting: 'Starting',
  offline: 'Offline',
  error: 'Error',
};

function statusTone(state: ProviderStatus['state']): string {
  if (state === 'ready') return 'is-ok';
  if (state === 'starting') return 'is-warn';
  if (state === 'error') return 'is-danger';
  return 'is-muted';
}

function kindOrder(kind: ProviderKind): number {
  const position = PROVIDER_KINDS.findIndex((meta) => meta.kind === kind);
  return position === -1 ? PROVIDER_KINDS.length : position;
}

interface FeaturedProviderCardProps {
  provider: ProviderConfig;
  onProviderEnabled: (saved: ProviderConfig) => void;
}

/** The featured provider: connection, auto-start, launch flags, env and the graph. */
function FeaturedProviderCard({ provider, onProviderEnabled }: FeaturedProviderCardProps): ReactNode {
  const studio = useStudio();
  const meta = providerKindMeta(provider.kind);
  const graphId = useId();
  const workflowId = `${graphId}-workflow`;
  const workflowHintId = `${graphId}-workflow-hint`;
  const argsId = `${graphId}-args`;
  const argsHintId = `${graphId}-args-hint`;
  const envId = `${graphId}-env`;
  const envHintId = `${graphId}-env-hint`;
  const isComfy = provider.kind === 'comfyui';
  const supportsLaunch = provider.kind !== 'mock';
  const enabled = isProviderEnabled(provider);

  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>(() => savedTimeoutSeconds(provider));
  const [launchEnabled, setLaunchEnabled] = useState<boolean>(provider.launch?.enabled === true);
  const [launchCommand, setLaunchCommand] = useState<string>(provider.launch?.command ?? '');
  const [launchCwd, setLaunchCwd] = useState<string>(provider.launch?.cwd ?? '');
  const [argsText, setArgsText] = useState<string>(() => formatLaunchArguments(provider.launch?.args));
  const [envText, setEnvText] = useState<string>(() => formatEnvLines(provider.launch?.env));
  const [workflow, setWorkflow] = useState<string>(() => savedWorkflowTemplate(provider));
  const [capabilities, setCapabilities] = useState<Record<string, unknown> | null>(() =>
    savedCapabilityOverride(provider),
  );
  const [graphOpen, setGraphOpen] = useState(false);
  const [busy, setBusy] = useState<'none' | 'saving' | 'testing' | 'toggling'>('none');
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);
  const [health, setHealth] = useState<ProviderStatus | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setHealth(await getProviderStatus(provider.id));
    } catch {
      setHealth({ state: 'offline', detail: 'The provider status could not be read.' });
    }
  }, [provider.id]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const idle = busy === 'none';
  const trimmedUrl = baseUrl.trim();
  const timeoutValue = Number(timeoutSeconds);
  const timeoutValid =
    isComfy && timeoutSeconds.trim().length > 0 && Number.isInteger(timeoutValue) && timeoutValue > 0;
  const timeoutProblem = isComfy && !timeoutValid ? 'Timeout must be a whole number of seconds above zero.' : null;
  const parsedArgs = parseLaunchArguments(argsText);
  const parsedEnv = parseEnvLines(envText);
  const workflowProblem = workflowTemplateProblem(workflow);
  const launchProblem =
    !supportsLaunch || !launchEnabled
      ? null
      : launchCommand.trim().length === 0
        ? 'A command is needed before the studio can start this provider.'
        : null;
  const argsProblem =
    supportsLaunch && parsedArgs === null
      ? 'Arguments must be space separated, one per line, or a JSON array of strings.'
      : null;
  const canSave =
    idle &&
    trimmedUrl.length > 0 &&
    workflowProblem === null &&
    launchProblem === null &&
    argsProblem === null &&
    parsedEnv.problem === null &&
    (!isComfy || timeoutValid);

  const optionsDraft = useCallback((): Record<string, unknown> | undefined => {
    if (!isComfy) return undefined;
    const next: Record<string, unknown> = { ...(provider.options ?? {}) };
    delete next['workflowTemplate'];
    delete next['capabilities'];
    const template = workflow.trim();
    if (template.length > 0) next['workflowTemplate'] = template;
    if (capabilities !== null) next['capabilities'] = capabilities;
    if (timeoutValid) next['timeoutMs'] = Math.round(timeoutValue * 1000);
    return next;
  }, [capabilities, isComfy, provider.options, timeoutValid, timeoutValue, workflow]);

  const buildBody = useCallback((): ProviderUpdateBody => {
    const body: ProviderUpdateBody = { baseUrl: trimmedUrl };
    if (supportsLaunch) {
      // Launch is always written, so clearing the last argument really clears it on disk.
      body.launch = {
        enabled: launchEnabled,
        command: launchCommand.trim(),
        args: parsedArgs ?? [],
        env: parsedEnv.env,
        ...(launchCwd.trim().length > 0 ? { cwd: launchCwd.trim() } : {}),
      };
    }
    const options = optionsDraft();
    if (options !== undefined) body.options = options;
    return body;
  }, [argsText, envText, launchCommand, launchCwd, launchEnabled, optionsDraft, supportsLaunch, trimmedUrl]);

  const dirty =
    trimmedUrl !== provider.baseUrl ||
    workflow !== savedWorkflowTemplate(provider) ||
    !sameJson(capabilities, savedCapabilityOverride(provider)) ||
    (isComfy && timeoutSeconds !== savedTimeoutSeconds(provider)) ||
    (supportsLaunch &&
      (launchEnabled !== (provider.launch?.enabled === true) ||
        launchCommand.trim() !== (provider.launch?.command ?? '').trim() ||
        launchCwd.trim() !== (provider.launch?.cwd ?? '').trim() ||
        JSON.stringify(parsedArgs) !== JSON.stringify(provider.launch?.args ?? []) ||
        formatEnvLines(parsedEnv.env) !== formatEnvLines(provider.launch?.env)));

  const save = useCallback(async (): Promise<void> => {
    setBusy('saving');
    setStatus(null);
    try {
      await updateProvider(provider.id, buildBody());
      await studio.refresh();
      setStatus({ tone: 'ok', message: 'Settings saved. The provider uses them on the next run.' });
      void loadStatus();
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [buildBody, loadStatus, provider.id, studio]);

  const test = useCallback(async (): Promise<void> => {
    setBusy('testing');
    setStatus(null);
    try {
      const saved = dirty ? await updateProvider(provider.id, buildBody()) : provider;
      const result = await checkProviderHealth(saved.id);
      const prefix = dirty ? 'Saved the changes, then tested. ' : '';
      setStatus(
        result.ok
          ? { tone: 'ok', message: `${prefix}${result.detail ?? 'The provider answered.'}` }
          : { tone: 'error', message: `${prefix}${result.detail ?? 'The provider did not answer.'}` },
      );
      if (dirty) await studio.refresh();
      void loadStatus();
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [buildBody, dirty, loadStatus, provider, studio]);

  const toggle = useCallback(async (): Promise<void> => {
    setBusy('toggling');
    setStatus(null);
    try {
      if (isProviderEnabled(provider)) {
        await updateProvider(provider.id, { enabled: false });
        await studio.refresh();
        setStatus({ tone: 'ok', message: `${provider.label} is disabled.` });
      } else {
        // Enabling saves what is on screen first, so the user enables the config they see.
        const saved = await updateProvider(provider.id, { ...buildBody(), enabled: true });
        await studio.refresh();
        onProviderEnabled(saved);
        setStatus({ tone: 'ok', message: `${saved.label} is enabled.` });
      }
      void loadStatus();
    } catch (error) {
      setStatus({ tone: 'error', message: describeError(error) });
    } finally {
      setBusy('none');
    }
  }, [buildBody, loadStatus, onProviderEnabled, provider, studio]);

  const statusState: ProviderStatus['state'] = health === null ? 'starting' : health.state;

  return (
    <section className="pr-card" aria-labelledby={`${graphId}-title`}>
      <header className="pr-head">
        <div className="pr-head-main">
          <div className="pr-head-title">
            <h2 className="pr-name" id={`${graphId}-title`}>
              {provider.label}
            </h2>
            <span className="pr-badge is-kind">{meta.kind}</span>
            <span className={enabled ? 'pr-badge is-enabled' : 'pr-badge is-muted'}>
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className={`pr-badge ${statusTone(statusState)}`} title={health?.detail ?? undefined}>
              <span className="pr-badge-dot" aria-hidden="true" />
              {STATUS_LABELS[statusState]}
            </span>
          </div>
          <p className="pr-summary">{meta.summary}</p>
        </div>
        <div className="pr-head-actions">
          {dirty ? <span className="pr-dirty">Unsaved changes</span> : null}
          <Button variant="secondary" size="sm" busy={busy === 'testing'} disabled={!canSave} onClick={() => void test()}>
            Test connection
          </Button>
          <Button
            variant="secondary"
            size="sm"
            busy={busy === 'saving'}
            disabled={!canSave || !dirty}
            onClick={() => void save()}
          >
            Save changes
          </Button>
          <Button
            variant={enabled ? 'ghost' : 'primary'}
            size="sm"
            busy={busy === 'toggling'}
            disabled={!canSave}
            onClick={() => void toggle()}
          >
            {enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </header>

      <div className="pr-form">
        <div className="pr-column">
          <fieldset className="pr-group">
            <legend className="section-label">Connection</legend>
            <Field
              label="Base URL"
              value={baseUrl}
              spellCheck={false}
              autoComplete="off"
              disabled={!idle}
              hint={`Default: ${meta.defaultBaseUrl}`}
              onChange={(event) => {
                setBaseUrl(event.target.value);
              }}
            />
            {isComfy ? (
              <Field
                label="Timeout (s)"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={timeoutSeconds}
                disabled={!idle}
                invalid={!timeoutValid}
                hint={timeoutProblem ?? 'The H3 default is 900 s (15 minutes).'}
                onChange={(event) => {
                  setTimeoutSeconds(event.target.value);
                }}
              />
            ) : null}
          </fieldset>

          {supportsLaunch ? (
            <fieldset className="pr-group">
              <legend className="section-label">Auto-start</legend>
              <label className="sw-switch pr-switch">
                <input
                  type="checkbox"
                  checked={launchEnabled}
                  disabled={!idle}
                  onChange={(event) => {
                    setLaunchEnabled(event.target.checked);
                  }}
                />
                <span className="sw-switch-track" aria-hidden="true" />
                <span className="sw-switch-copy">
                  <span className="sw-switch-label">Start with H3 Studio</span>
                  <span className="sw-switch-hint">Runs the command on studio start and stops it again on quit.</span>
                </span>
              </label>
              {launchEnabled ? (
                <>
                  <Field
                    label="Command"
                    value={launchCommand}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={!idle}
                    placeholder="python"
                    hint="The program to run. A bare name is looked up on PATH."
                    onChange={(event) => {
                      setLaunchCommand(event.target.value);
                    }}
                  />
                  <Field
                    label="Working folder"
                    value={launchCwd}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={!idle}
                    placeholder="The ComfyUI folder, for example"
                    hint="Optional. The command runs from here."
                    onChange={(event) => {
                      setLaunchCwd(event.target.value);
                    }}
                  />
                </>
              ) : null}
            </fieldset>
          ) : null}
        </div>

        <div className="pr-column">
          {supportsLaunch ? (
            <>
              <div className="field">
                <label className="field-label" htmlFor={argsId}>
                  Launch arguments
                </label>
                <textarea
                  id={argsId}
                  className="field-textarea pr-code"
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={argsText}
                  disabled={!idle}
                  placeholder="-u main.py --listen 127.0.0.1 --port 8188 --cache-none"
                  aria-invalid={argsProblem === null ? undefined : true}
                  aria-describedby={argsProblem === null ? argsHintId : `${argsHintId} ${argsId}-error`}
                  onChange={(event) => {
                    setArgsText(event.target.value);
                  }}
                />
                <p className="field-hint" id={argsHintId}>
                  Space separated or one per line. The Setup Wizard writes these automatically.
                </p>
                {argsProblem === null && launchProblem === null ? null : (
                  <p className="field-error" id={`${argsId}-error`} role="alert">
                    {argsProblem ?? launchProblem}
                  </p>
                )}
              </div>

              <div className="field">
                <label className="field-label" htmlFor={envId}>
                  Environment variables
                </label>
                <textarea
                  id={envId}
                  className="field-textarea pr-code"
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={envText}
                  disabled={!idle}
                  placeholder="TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1"
                  aria-invalid={parsedEnv.problem === null ? undefined : true}
                  aria-describedby={parsedEnv.problem === null ? envHintId : `${envHintId} ${envId}-error`}
                  onChange={(event) => {
                    setEnvText(event.target.value);
                  }}
                />
                <p className="field-hint" id={envHintId}>
                  One KEY=VALUE per line, merged over the studio environment for this process only.
                </p>
                {parsedEnv.problem === null ? null : (
                  <p className="field-error" id={`${envId}-error`} role="alert">
                    {parsedEnv.problem}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="pr-quiet">
              The mock provider runs inside the studio server, so there is nothing to launch and no environment to set.
            </p>
          )}
        </div>
      </div>

      {status === null ? null : (
        <p className={status.tone === 'ok' ? 'pr-status is-ok' : 'pr-status is-error'} role="status">
          {status.message}
        </p>
      )}

      {isComfy ? (
        <section className="pr-advanced" aria-labelledby={`${graphId}-advanced`}>
          <button
            type="button"
            className="pr-advanced-toggle"
            aria-expanded={graphOpen}
            aria-controls={`${graphId}-panel`}
            onClick={() => {
              setGraphOpen(!graphOpen);
            }}
          >
            <svg className="icon pr-disclosure" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9.5 6.5L15 12l-5.5 5.5" />
            </svg>
            <span className="pr-advanced-title" id={`${graphId}-advanced`}>
              Advanced graph
            </span>
            <span className="pr-advanced-count">
              {workflow.trim().length === 0 ? 'Default graph' : 'Custom graph'}
            </span>
          </button>
          <div className="pr-advanced-panel" id={`${graphId}-panel`} hidden={!graphOpen}>
            <div className="field">
              <label className="field-label" htmlFor={workflowId}>
                Workflow template
              </label>
              <textarea
                id={workflowId}
                className="field-textarea pr-code"
                rows={10}
                spellCheck={false}
                autoComplete="off"
                value={workflow}
                disabled={!idle}
                aria-invalid={workflowProblem === null ? undefined : true}
                aria-describedby={workflowProblem === null ? workflowHintId : `${workflowHintId} ${workflowId}-error`}
                placeholder={`{\n  "3": {\n    "class_type": "KSampler",\n    "inputs": { "seed": "{{seed}}", "steps": "{{steps}}" }\n  }\n}`}
                onChange={(event) => {
                  setWorkflow(event.target.value);
                }}
              />
              <p className="field-hint" id={workflowHintId}>
                Placeholders:{' '}
                {WORKFLOW_PLACEHOLDERS.map((name, index) => (
                  <span key={name}>
                    {index === 0 ? null : ', '}
                    <code className="pr-token">{`{{${name}}}`}</code>
                  </span>
                ))}
                . ComfyUI API format only (Workflow menu, Export (API)). Empty keeps the built in graph.
              </p>
              {workflowProblem === null ? null : (
                <p className="field-error" id={`${workflowId}-error`} role="alert">
                  {workflowProblem}
                </p>
              )}
            </div>
            <div className="pr-advanced-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={!idle}
                onClick={() => {
                  setWorkflow(H3_IMAGE_TEMPLATE_JSON);
                }}
              >
                Load H3 Image graph
              </Button>
              <Button variant="ghost" size="sm" disabled={!idle} onClick={() => setWorkflow('')}>
                Clear graph
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!idle}
                onClick={() => {
                  setCapabilities({ ...H3_IMAGE_CAPABILITIES });
                  if (!timeoutValid) setTimeoutSeconds('900');
                }}
              >
                H3 Image capabilities
              </Button>
              {capabilities === null ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!idle}
                  onClick={() => {
                    setCapabilities(null);
                  }}
                >
                  Clear override
                </Button>
              )}
            </div>
            {capabilities === null ? null : <p className="pr-quiet">{describeCapabilityOverride(capabilities)}</p>}
          </div>
        </section>
      ) : null}

      <footer className="pr-foot">
        <span className="pr-quiet">
          Provider id <span className="pr-code-inline">{provider.id}</span>
        </span>
      </footer>
    </section>
  );
}

function OtherProviderCard({
  provider,
  onSelect,
  onToggle,
  busy,
}: {
  provider: ProviderConfig;
  onSelect: (providerId: string) => void;
  onToggle: (provider: ProviderConfig) => Promise<void> | void;
  busy: boolean;
}): ReactNode {
  const meta = providerKindMeta(provider.kind);
  const enabled = isProviderEnabled(provider);
  return (
    <article className="pr-other">
      <header className="pr-other-head">
        <h3 className="pr-other-name">{provider.label}</h3>
        <span className={enabled ? 'pr-badge is-enabled' : 'pr-badge is-muted'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </header>
      <span className="pr-badge is-kind">{meta.kind}</span>
      <p className="pr-other-summary">{meta.summary}</p>
      <span className="pr-other-url" title={provider.baseUrl}>
        {provider.baseUrl}
      </span>
      <div className="pr-other-actions">
        <Button variant="ghost" size="sm" onClick={() => onSelect(provider.id)}>
          Configure
        </Button>
        <Button
          variant={enabled ? 'ghost' : 'secondary'}
          size="sm"
          busy={busy}
          onClick={() => void onToggle(provider)}
        >
          {enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
    </article>
  );
}

function MissingProviderCard({
  meta,
  busy,
  onAdd,
}: {
  meta: ProviderKindMeta;
  busy: boolean;
  onAdd: (meta: ProviderKindMeta) => void;
}): ReactNode {
  return (
    <article className="pr-other is-missing">
      <header className="pr-other-head">
        <h3 className="pr-other-name">{meta.label}</h3>
        <span className="pr-badge is-muted">Not added</span>
      </header>
      <span className="pr-badge is-kind">{meta.kind}</span>
      <p className="pr-other-summary">{meta.summary}</p>
      <div className="pr-other-actions">
        <Button variant="secondary" size="sm" busy={busy} onClick={() => onAdd(meta)}>
          Add provider
        </Button>
      </div>
    </article>
  );
}

export function ProvidersPanel({ onProviderEnabled }: ProvidersPanelProps): ReactNode {
  const studio = useStudio();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const providers = studio.providers;

  const featured = useMemo<ProviderConfig | null>(() => {
    const chosen = selectedId === null ? undefined : providers.find((provider) => provider.id === selectedId);
    if (chosen !== undefined) return chosen;
    return (
      providers.find((provider) => isProviderEnabled(provider) && provider.kind === 'comfyui') ??
      providers.find((provider) => isProviderEnabled(provider) && provider.kind !== 'mock') ??
      providers.find((provider) => isProviderEnabled(provider)) ??
      providers.find((provider) => provider.kind === 'comfyui') ??
      providers[0] ??
      null
    );
  }, [providers, selectedId]);

  // Pinning the first choice keeps the featured card from jumping away when that provider
  // is disabled: the card you were editing stays the card you are editing.
  useEffect(() => {
    if (selectedId === null && featured !== null) setSelectedId(featured.id);
  }, [featured, selectedId]);

  const others = useMemo(
    () =>
      providers
        .filter((provider) => provider.id !== featured?.id)
        .sort((left, right) => kindOrder(left.kind) - kindOrder(right.kind)),
    [featured, providers],
  );

  const missing = useMemo(
    () => PROVIDER_KINDS.filter((meta) => !providers.some((provider) => provider.kind === meta.kind)),
    [providers],
  );

  const toggleOther = useCallback(
    async (provider: ProviderConfig): Promise<void> => {
      setBusyId(provider.id);
      try {
        const enabling = !isProviderEnabled(provider);
        const saved = await updateProvider(provider.id, { enabled: enabling });
        await studio.refresh();
        // Enabling a compact card promotes it, because the next thing the user wants is the
        // full form for the provider they just turned on.
        if (enabling) setSelectedId(saved.id);
        if (isProviderEnabled(saved)) onProviderEnabled(saved);
        studio.notify(`${saved.label} is ${isProviderEnabled(saved) ? 'enabled' : 'disabled'}.`);
      } catch (error) {
        studio.notify(describeError(error), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [onProviderEnabled, studio],
  );

  const addProvider = useCallback(
    async (meta: ProviderKindMeta): Promise<void> => {
      setBusyId(meta.kind);
      try {
        const created = await createProvider({
          kind: meta.kind,
          label: meta.label,
          baseUrl: meta.defaultBaseUrl,
          enabled: false,
        });
        await studio.refresh();
        setSelectedId(created.id);
        studio.notify(`${created.label} was added. Enable it when it is ready.`);
      } catch (error) {
        studio.notify(describeError(error), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [studio],
  );

  return (
    <div className="pr">
      {featured === null ? (
        <p className="pr-quiet">No provider is configured. Add one below to get started.</p>
      ) : (
        <>
          <div className="pr-featured-label">
            <span className="section-label">Active provider</span>
            <span className="pr-quiet">
              {providers.filter(isProviderEnabled).length} of {providers.length} enabled
            </span>
          </div>
          <FeaturedProviderCard
            key={featured.id}
            provider={featured}
            onProviderEnabled={onProviderEnabled}
          />
        </>
      )}

      <section className="pr-others" aria-labelledby="pr-others-title">
        <div className="pr-others-head">
          <h2 className="pr-others-title" id="pr-others-title">
            Other providers
          </h2>
          <p className="pr-quiet">Configure one to bring it into the featured card above.</p>
        </div>
        <div className="pr-others-grid">
          {others.map((provider) => (
            <OtherProviderCard
              key={provider.id}
              provider={provider}
              busy={busyId === provider.id}
              onSelect={(providerId) => setSelectedId(providerId)}
              onToggle={toggleOther}
            />
          ))}
          {missing.map((meta) => (
            <MissingProviderCard
              key={meta.kind}
              meta={meta}
              busy={busyId === meta.kind}
              onAdd={(target) => void addProvider(target)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
