// The generate screen slots. App mounts GenerateCanvas in the centre panel and
// GenerateControls in the inspector; both read the same controller, so a run
// started in the composer is visible in the grid immediately.

import { useCallback, useState, type ReactNode } from 'react';
import type { BatchRecord } from '../../../core/types';
import { getBatch, listBatches } from '../../api';
import { useStudio } from '../../studio';
import { ImageViewer } from '../library/viewer';
import { PromptComposer } from './composer';
import { GenerationControls } from './controls';
import { ResultsGrid } from './results';
import { useGeneration } from './useGeneration';
import './generate.css';

interface ViewerState {
  batch: BatchRecord;
  imageId: string;
  trigger: HTMLElement | null;
  /** Opens the source image first, so an alteration is read against what it changed. */
  compare: boolean;
}

export function GenerateCanvas(): ReactNode {
  const generation = useGeneration();
  const studio = useStudio();
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const openImage = useCallback(
    async (imageId: string, trigger: HTMLElement | null, compare = false): Promise<void> => {
      const batchId = generation.batch === null ? null : generation.batch.batchId;
      try {
        if (batchId !== null) {
          const record = await getBatch(batchId);
          if (record.images.some((image) => image.id === imageId)) {
            setViewer({ batch: record, imageId, trigger, compare });
            return;
          }
        }
        // A retry stores its images in a new batch, so the image may belong to a newer
        // record than the one the canvas is displaying. Find the batch that owns it.
        const recent = await listBatches(100);
        const owner = recent.find((candidate) => candidate.images.some((image) => image.id === imageId));
        if (owner === undefined) {
          studio.notify('That image is no longer in the library.', 'error');
          return;
        }
        setViewer({ batch: owner, imageId, trigger, compare });
      } catch {
        studio.notify('The batch could not be opened.', 'error');
      }
    },
    [generation.batch, studio],
  );

  const closeViewer = useCallback((): void => {
    setViewer(null);
  }, []);

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
        onOpenImage={(imageId, trigger) => {
          void openImage(imageId, trigger);
        }}
        onCompareImage={(imageId, trigger) => {
          void openImage(imageId, trigger, true);
        }}
        onUseStarter={generation.setPrompt}
        alterationSourceId={
          generation.alterationTarget === null ? null : generation.alterationTarget.imageId
        }
        onSelectSource={generation.selectSourceImage}
      />
      <PromptComposer
        form={generation.form}
        running={generation.running}
        canGenerate={generation.canGenerate}
        blockedReason={generation.blockedReason}
        maxReferenceImages={
          generation.capability.capabilities === null
            ? 0
            : generation.capability.capabilities.maxReferenceImages
        }
        onAddReference={generation.addReference}
        onRemoveReference={generation.removeReference}
        alterationSource={generation.alterationTarget}
        alterationCandidates={generation.alterationCandidates}
        onSelectAlterationSource={generation.selectSourceImage}
        onNewImage={generation.startNewImage}
        focusNonce={generation.promptFocusNonce}
        onChange={generation.setPrompt}
        onGenerate={generation.start}
        onCancel={generation.cancel}
      />
      {viewer === null ? null : (
        <ImageViewer
          batch={viewer.batch}
          imageId={viewer.imageId}
          providerLabel={
            studio.providers.find((provider) => provider.id === viewer.batch.providerId)?.label ??
            viewer.batch.providerId
          }
          initialCompare={viewer.compare}
          onClose={closeViewer}
          returnFocusTo={viewer.trigger}
        />
      )}
    </div>
  );
}

export function GenerateControls(): ReactNode {
  const { provider } = useStudio();
  const generation = useGeneration();
  const providerLabel = provider === null ? null : provider.label;

  return <GenerationControls controller={generation} providerLabel={providerLabel} />;
}
