import React, { useState } from 'react';
import type {
  AnchorOverrideRecord,
  DataProvenance,
  RaceComparisonManifest,
} from '../../shared/types.js';

export interface AnchorCalibrationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  manifest: RaceComparisonManifest;
  onApplyClientOverrides: (overrides: AnchorOverrideRecord[]) => void;
  onSaveToD1: (overrides: AnchorOverrideRecord[]) => Promise<void>;
  onResetFactoryBaseline: () => Promise<void>;
}

function getProvenanceBadge(prov: DataProvenance, isSyntheticDemo?: boolean) {
  let badgeClass = 'badge-interp';
  let label = 'Kinematic Interpolated';

  if (prov === 'SIMULATED' || (isSyntheticDemo && prov !== 'MANUALLY_ANNOTATED')) {
    label = 'Simulated';
  } else if (prov === 'OCR_MEASURED') {
    badgeClass = 'badge-ocr';
    label = 'OCR Measured';
  } else if (prov === 'GNSS_DERIVED') {
    badgeClass = 'badge-gate';
    label = 'GNSS Derived';
  } else if (prov === 'GATE_CALIBRATED') {
    badgeClass = 'badge-gate';
    label = 'Gate-Calibrated';
  } else if (prov === 'MANUALLY_ANNOTATED') {
    badgeClass = 'badge-manual';
    label = 'Manually Annotated';
  }

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badgeClass}`}
    >
      {label}
    </span>
  );
}

export const AnchorCalibrationDrawer: React.FC<AnchorCalibrationDrawerProps> = ({
  isOpen,
  onClose,
  manifest,
  onApplyClientOverrides,
  onSaveToD1,
  onResetFactoryBaseline,
}) => {
  const [selectedAthleteId, setSelectedAthleteId] = useState<string>(
    manifest.athleteB.athleteId
  );
  const [localOverrides, setLocalOverrides] = useState<Map<string, number>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentAthlete =
    selectedAthleteId === manifest.athleteA.athleteId
      ? manifest.athleteA
      : manifest.athleteB;

  const frameStepSec = 1 / currentAthlete.nativeFps; // ~0.0334s

  const handleNudge = (anchorId: string, deltaFrames: number) => {
    const anchor = currentAthlete.anchors.find((a) => a.anchorId === anchorId);
    if (!anchor) return;

    const currentTs = localOverrides.get(anchorId) ?? anchor.videoTimestampSec;
    const newTs = Math.max(0, Number((currentTs + deltaFrames * frameStepSec).toFixed(4)));

    const nextOverrides = new Map(localOverrides);
    nextOverrides.set(anchorId, newTs);
    setLocalOverrides(nextOverrides);

    // Apply client-side in-memory solve immediately (< 2ms)
    const records: AnchorOverrideRecord[] = Array.from(nextOverrides.entries()).map(
      ([aId, ts]) => ({
        raceId: manifest.raceId,
        athleteId: selectedAthleteId,
        anchorId: aId,
        videoTimestampSec: ts,
        provenance: 'MANUALLY_ANNOTATED',
      })
    );
    onApplyClientOverrides(records);
    setStatusMessage(`Nudged ${anchorId} by ${deltaFrames > 0 ? '+' : ''}${deltaFrames} frame(s). Recomputed in < 2ms.`);
  };

  const handleSave = async () => {
    if (localOverrides.size === 0) return;
    setIsSaving(true);
    setStatusMessage('Saving overrides...');
    try {
      const records: AnchorOverrideRecord[] = Array.from(localOverrides.entries()).map(
        ([aId, ts]) => ({
          raceId: manifest.raceId,
          athleteId: selectedAthleteId,
          anchorId: aId,
          videoTimestampSec: ts,
          provenance: 'MANUALLY_ANNOTATED',
        })
      );
      await onSaveToD1(records);
      setStatusMessage('Saved anchor overrides for this preview.');
    } catch (err: unknown) {
      setStatusMessage(`Could not save overrides. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    setStatusMessage('Resetting to factory baseline...');
    try {
      setLocalOverrides(new Map());
      await onResetFactoryBaseline();
      setStatusMessage('Reset to factory baseline manifest complete.');
    } catch (err: unknown) {
      setStatusMessage(`Error resetting: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      data-testid="anchor-calibration-drawer"
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm"
    >
      <div className="flex h-full w-full max-w-xl flex-col border-l border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-4">
          <div>
            <h3 className="text-base font-bold text-white brand-font">
              Inspect &amp; Calibrate Anchors
            </h3>
            <p className="text-xs text-slate-400">
              Audit data provenance or adjust gate frame timestamps live (&plusmn;0.033s)
            </p>
          </div>
          <button
            data-testid="close-calibration-drawer-btn"
            onClick={onClose}
            className="rounded-lg bg-slate-800 p-2 text-slate-400 hover:bg-slate-700 hover:text-white"
          >
            <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* Athlete Switcher */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 p-3">
          <div className="flex w-full rounded-lg border border-slate-800 bg-slate-900 p-0.5">
            <button
              onClick={() => setSelectedAthleteId(manifest.athleteA.athleteId)}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                selectedAthleteId === manifest.athleteA.athleteId
                  ? 'bg-slate-800 text-cyan-400 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {manifest.athleteA.athleteName} ({manifest.athleteA.countryCode})
            </button>
            <button
              onClick={() => setSelectedAthleteId(manifest.athleteB.athleteId)}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                selectedAthleteId === manifest.athleteB.athleteId
                  ? 'bg-slate-800 text-amber-400 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {manifest.athleteB.athleteName} ({manifest.athleteB.countryCode})
            </button>
          </div>
        </div>

        {/* Status notification banner */}
        {statusMessage && (
          <div className="border-b border-slate-800 bg-cyan-950/40 px-4 py-2 text-xs text-cyan-300 font-mono">
            {statusMessage}
          </div>
        )}

        {/* Anchor List */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {currentAthlete.anchors.map((anchor) => {
            const hasLocalOverride = localOverrides.has(anchor.anchorId);
            const displayTimestamp =
              localOverrides.get(anchor.anchorId) ?? anchor.videoTimestampSec;
            const effectiveProv = hasLocalOverride
              ? 'MANUALLY_ANNOTATED'
              : anchor.provenance;

            return (
              <div
                key={anchor.anchorId}
                data-testid={`anchor-row-${anchor.anchorId}`}
                className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-3 transition hover:border-slate-700"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">
                      {anchor.label}
                    </span>
                    {getProvenanceBadge(effectiveProv, manifest.isSyntheticDemo)}
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400 tabular-nums">
                    <span>t = {displayTimestamp.toFixed(3)}s</span>
                    <span>s = {anchor.normalizedProgress.toFixed(2)}</span>
                    {anchor.gnssSpeedKmh !== undefined && (
                      <span className="text-emerald-400">
                        {anchor.gnssSpeedKmh} km/h (GNSS)
                      </span>
                    )}
                    {!manifest.isSyntheticDemo && anchor.ocrSpeedKmh !== null && (
                      <span className="text-emerald-400">
                        {anchor.ocrSpeedKmh} km/h (OCR)
                      </span>
                    )}
                  </div>
                </div>

                {/* Frame Step Nudge Buttons */}
                <div className="flex items-center gap-1.5">
                  <button
                    data-testid={`nudge-back-btn-${anchor.anchorId}`}
                    onClick={() => handleNudge(anchor.anchorId, -1)}
                    title="-1 Frame (-0.033s)"
                    className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-mono text-slate-300 hover:bg-slate-700 active:scale-95"
                  >
                    -1F
                  </button>
                  <button
                    data-testid={`nudge-fwd-btn-${anchor.anchorId}`}
                    onClick={() => handleNudge(anchor.anchorId, 1)}
                    title="+1 Frame (+0.033s)"
                    className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-mono text-slate-300 hover:bg-slate-700 active:scale-95"
                  >
                    +1F
                  </button>
                  <button
                    data-testid={`nudge-2f-fwd-btn-${anchor.anchorId}`}
                    onClick={() => handleNudge(anchor.anchorId, 2)}
                    title="+2 Frames (+0.067s)"
                    className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs font-mono text-cyan-300 hover:bg-cyan-500/20 active:scale-95"
                  >
                    +2F
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/80 p-4">
          <button
            data-testid="reset-baseline-btn"
            onClick={handleReset}
            disabled={isSaving}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-50"
          >
            Reset to Baseline
          </button>

          <button
            data-testid="apply-anchor-override-btn"
            onClick={handleSave}
            disabled={isSaving || localOverrides.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-bold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            <span>Save overrides</span>
            {localOverrides.size > 0 && (
              <span className="rounded-full bg-slate-950/30 px-1.5 py-0.2 text-[10px]">
                {localOverrides.size}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
