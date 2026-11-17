// The generate screen slots. App mounts GenerateCanvas in the centre panel and
// GenerateControls in the inspector; both read the same controller, so a run
// started in the composer is visible in the grid immediately.

import type { ReactNode } from 'react';
import { useStudio } from '../../App';
import { PromptComposer } from './composer';
import { GenerationControls } from './controls';
import { ResultsGrid } from './results';
import { useGeneration } from './useGeneration';
import './generate.css';

export function GenerateCanvas(): ReactNode {
  const generation = useGeneration();

  return (
    <div className="gen-canvas">
      <ResultsGrid
        batch={generation.batch}
        summary={generation.summary}
        running={generation.running}
        plannedWidth={Math.max(1, generation.form.width)}
        plannedHeight={Math.max(1, generation.form.height)}
        onRetry={generation.retry}
        onRetryFailed={generation.retryFailed}
        onReload={generation.reloadBatch}
        onUseStarter={generation.setPrompt}
      />
      <PromptComposer
        form={generation.form}
        running={generation.running}
        canGenerate={generation.canGenerate}
        blockedReason={generation.blockedReason}
        onChange={generation.setPrompt}
        onGenerate={generation.start}
        onCancel={generation.cancel}
      />
    </div>
  );
}

export function GenerateControls(): ReactNode {
  const { provider } = useStudio();
  const generation = useGeneration();
  const providerLabel = provider === null ? null : provider.label;

  return <GenerationControls controller={generation} providerLabel={providerLabel} />;
}
