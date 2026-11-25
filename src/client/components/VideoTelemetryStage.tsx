import React, { useEffect, useRef } from 'react';
import type { TelemetrySyncState } from '../hooks/useTelemetrySync.js';
import type { RaceComparisonManifest } from '../../shared/types.js';
import { F1GhostHud } from './F1GhostHud.js';
import { TrackedAthleteVideo } from './TrackedAthleteVideo.js';

const CAMERA_ZONES = [
  { pos: 1, label: 'Start House & Upper Flat', s0: 0.0, s1: 0.14 },
  { pos: 2, label: 'Flyaway & The Brink Entry', s0: 0.14, s1: 0.22 },
  { pos: 3, label: 'The Brink Rollover & Talon', s0: 0.22, s1: 0.33 },
  { pos: 4, label: 'Talon Steep & Screech Owl Jump', s0: 0.33, s1: 0.505 },
  { pos: 5, label: 'Peregrine Steep & Golden Eagle Approach', s0: 0.505, s1: 0.665 },
  { pos: 6, label: 'Golden Eagle & Abyss Compression', s0: 0.665, s1: 0.8 },
  { pos: 7, label: 'Harrier Technical Turns', s0: 0.8, s1: 0.92 },
  { pos: 8, label: 'STIFEL Arch, Red Tail Jump & Finish', s0: 0.92, s1: 1.0 },
] as const;

function getCameraZoneForProgress(s: number) {
  for (let i = 0; i < CAMERA_ZONES.length; i++) {
    const z = CAMERA_ZONES[i];
    if (s < z.s1 - 1e-4 || i === CAMERA_ZONES.length - 1) return z;
  }
  return CAMERA_ZONES[0];
}

export interface VideoTelemetryStageProps {
  manifest: RaceComparisonManifest;
  syncState: TelemetrySyncState;
  comparisonMode: 'PRIMARY_RUN' | 'SIDE_BY_SIDE';
  onChangeComparisonMode: (mode: 'PRIMARY_RUN' | 'SIDE_BY_SIDE') => void;
  syncMode: 'RACE_CLOCK' | 'SPATIAL_GHOST';
  onChangeSyncMode: (mode: 'RACE_CLOCK' | 'SPATIAL_GHOST') => void;
  playbackSpeed: 0.5 | 1 | 2;
  onChangePlaybackSpeed: (speed: 0.5 | 1 | 2) => void;
  snapshotGateNumber: number | null;
  onCloseSnapshot: () => void;
  onOpenCalibration: () => void;
}

export const VideoTelemetryStage: React.FC<VideoTelemetryStageProps> = ({
  manifest,
  syncState,
  comparisonMode,
  onChangeComparisonMode,
  syncMode,
  onChangeSyncMode,
  playbackSpeed,
  onChangePlaybackSpeed,
  snapshotGateNumber,
  onCloseSnapshot,
  onOpenCalibration,
}) => {
  const snapshotCanvasARef = useRef<HTMLCanvasElement>(null);
  const snapshotCanvasBRef = useRef<HTMLCanvasElement>(null);

  const athleteA = manifest.athleteA;
  const athleteB = manifest.athleteB;
  const course = manifest.courseProfile;

  const snapshotGate =
    snapshotGateNumber !== null
      ? course.gates.find((g) => g.gateNumber === snapshotGateNumber)
      : null;

  const snapshotSampleIdx = snapshotGate
    ? Math.max(0, Math.min(1000, Math.round(snapshotGate.normalizedProgress * 1000)))
    : 0;
  const snapshotSampleA = athleteA.samplesByProgress[snapshotSampleIdx];
  const snapshotSampleB = athleteB.samplesByProgress[snapshotSampleIdx];

  useEffect(() => {
    if (!snapshotGate || !snapshotSampleA || !snapshotSampleB) return;

    const capture = (
      canvas: HTMLCanvasElement | null, video: HTMLVideoElement | null, targetTime: number
    ) => {
      const context = canvas?.getContext('2d');
      if (!canvas || !video || !context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const draw = () => {
        if (video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - targetTime) < 0.08) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
      };

      video.addEventListener('seeked', draw);
      video.addEventListener('loadeddata', draw);
      video.currentTime = targetTime;
      draw();
      return () => {
        video.removeEventListener('seeked', draw);
        video.removeEventListener('loadeddata', draw);
      };
    };

    const stopA = capture(snapshotCanvasARef.current, syncState.primaryVideoRef.current,
      athleteA.startClipOffsetSec + snapshotSampleA.elapsedTimeSec);
    const stopB = capture(snapshotCanvasBRef.current, syncState.secondaryVideoRef.current,
      athleteB.startClipOffsetSec + snapshotSampleB.elapsedTimeSec);
    return () => { stopA?.(); stopB?.(); };
  }, [
    snapshotGate,
    snapshotSampleA,
    snapshotSampleB,
    athleteA.startClipOffsetSec,
    athleteB.startClipOffsetSec,
    syncState.primaryVideoRef,
    syncState.secondaryVideoRef,
  ]);

  return (
    <div
      data-testid="video-telemetry-stage"
      className="relative flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl"
    >
      {/* Top Bar: Playback Controls & View Mode Toggles */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/70 px-4 py-2.5 backdrop-blur-md">
        {/* Play/Pause & Frame Steps */}
        <div className="flex items-center gap-1.5">
          <button
            data-testid="play-pause-btn"
            onClick={syncState.togglePlay}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 font-bold text-slate-950 transition hover:bg-cyan-400 active:scale-95"
          >
            {syncState.isPlaying ? (
              <>
                <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
                <span>Pause</span>
              </>
            ) : (
              <>
                <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Play</span>
              </>
            )}
          </button>

          <button
            data-testid="step-back-btn"
            onClick={() => syncState.stepFrames(-1)}
            title="Step Back 1 Frame (-0.033s)"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 active:scale-95"
          >
            -1 F
          </button>
          <button
            data-testid="step-fwd-btn"
            onClick={() => syncState.stepFrames(1)}
            title="Step Forward 1 Frame (+0.033s)"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 active:scale-95"
          >
            +1 F
          </button>
        </div>

        {/* Speed Controls */}
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-slate-400">Speed:</span>
          {([0.5, 1, 2] as const).map((speed) => (
            <button
              key={speed}
              data-testid={`speed-btn-${speed}x`}
              onClick={() => onChangePlaybackSpeed(speed)}
              className={`rounded-md px-2.5 py-1 font-mono text-xs font-bold transition ${
                playbackSpeed === speed
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                  : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/60'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        {/* View Mode & Calibration Action */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
            <button
              data-testid="mode-primary-run-btn"
              onClick={() => onChangeComparisonMode('PRIMARY_RUN')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                comparisonMode === 'PRIMARY_RUN'
                  ? 'bg-slate-900 text-cyan-400 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show the primary run with comparison telemetry"
            >
              Primary run
            </button>
            <button
              data-testid="mode-side-by-side-btn"
              onClick={() => onChangeComparisonMode('SIDE_BY_SIDE')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                comparisonMode === 'SIDE_BY_SIDE'
                  ? 'bg-slate-900 text-amber-400 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Side-by-Side
            </button>
          </div>

          <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
            <button
              data-testid="sync-race-clock-btn"
              onClick={() => onChangeSyncMode('RACE_CLOCK')}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                syncMode === 'RACE_CLOCK'
                  ? 'bg-slate-900 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Both videos aligned at identical elapsed race time (t_B = t_A)"
            >
              Clock Sync
            </button>
            <button
              data-testid="sync-spatial-ghost-btn"
              onClick={() => onChangeSyncMode('SPATIAL_GHOST')}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                syncMode === 'SPATIAL_GHOST'
                  ? 'bg-slate-900 text-cyan-400 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Both videos aligned at identical course position (t_B = t_B(s_A))"
            >
              Same position
            </button>
          </div>

          <button
            data-testid="open-calibration-btn"
            onClick={onOpenCalibration}
            className="flex items-center gap-1 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 text-xs font-semibold text-fuchsia-300 transition hover:bg-fuchsia-500/20 active:scale-95"
          >
            <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
            <span>Calibrate</span>
          </button>
        </div>
      </div>

      {course.discipline === 'downhill' && (
        <div
          data-testid="camera-pos-ribbon"
          className="flex items-center justify-between gap-1 border-b border-slate-800/80 bg-slate-950/90 px-3 py-1.5 text-[11px]"
        >
          <div
            data-testid="active-camera-indicator"
            className="flex items-center gap-1.5 font-mono font-bold text-cyan-300"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            <span>
              CAM POS {getCameraZoneForProgress(syncState.normalizedProgress).pos}/8:{' '}
              {getCameraZoneForProgress(syncState.normalizedProgress).label}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {CAMERA_ZONES.map((z) => {
              const active =
                getCameraZoneForProgress(syncState.normalizedProgress).pos === z.pos;
              return (
                <button
                  key={z.pos}
                  data-testid={`cam-pos-btn-${z.pos}`}
                  onClick={() => syncState.seekToProgress(z.s0)}
                  title={`Jump to Camera POS${z.pos}: ${z.label}`}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold transition ${
                    active
                      ? 'bg-cyan-500 text-slate-950 shadow'
                      : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  POS{z.pos}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={comparisonMode === 'SIDE_BY_SIDE' ? 'athlete-video-grid' : 'athlete-video-single'}>
        <TrackedAthleteVideo
          key={athleteA.clipUrl}
          athlete={athleteA}
          videoRef={syncState.primaryVideoRef}
          onLoadedMetadata={() => syncState.seekToTime(syncState.elapsedTimeSec)}
          showTrack={!manifest.isSyntheticDemo}
          accent="cyan"
          cameraPosition={course.discipline === 'downhill'
            ? getCameraZoneForProgress(syncState.currentTemporalSampleA.normalizedProgress).pos
            : undefined}
        />
        <TrackedAthleteVideo
          key={athleteB.clipUrl}
          athlete={athleteB}
          videoRef={syncState.secondaryVideoRef}
          onLoadedMetadata={() => syncState.seekToTime(syncState.elapsedTimeSec)}
          showTrack={!manifest.isSyntheticDemo}
          accent="amber"
          muted
          hidden={comparisonMode === 'PRIMARY_RUN'}
          cameraPosition={course.discipline === 'downhill'
            ? getCameraZoneForProgress(
                syncMode === 'SPATIAL_GHOST'
                  ? syncState.normalizedProgress
                  : syncState.currentTemporalSampleB.normalizedProgress
              ).pos
            : undefined}
        />
      </div>

      {/* Docked Horizontal F1 Telemetry Bar Below Video Viewport (Never Obstructs Video) */}
      <F1GhostHud
        elapsedTimeSec={syncState.elapsedTimeSec}
        sampleA={syncState.currentSpatialSampleA}
        sampleB={syncState.currentSpatialSampleB}
        ghostDeltaSec={syncState.ghostDeltaSec}
        courseMapEnabled={course.courseMapEnabled}
        athleteAName={athleteA.athleteName}
        athleteBName={athleteB.athleteName}
        isSyntheticDemo={manifest.isSyntheticDemo}
      />

      {/* Gate Split Snapshot Freeze-Frame Modal (CUJ 2) */}
      {snapshotGateNumber !== null && snapshotGate && snapshotSampleA && snapshotSampleB && (
        <div
          data-testid="gate-split-snapshot-modal"
          className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-md"
        >
          <div className="flex max-w-2xl flex-col gap-4 rounded-2xl border border-cyan-500/40 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-cyan-400" />
                <h3 className="text-lg font-bold text-white">
                  Gate {snapshotGate.gateNumber} Split Snapshot ({snapshotGate.color} {snapshotGate.type})
                </h3>
              </div>
              <button
                data-testid="close-snapshot-btn"
                onClick={onCloseSnapshot}
                className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-cyan-500/30 bg-slate-950/70 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-cyan-400">
                    {athleteA.athleteName}
                  </span>
                  <span className="font-mono text-xs font-bold text-white tabular-nums">
                    {snapshotSampleA.elapsedTimeSec.toFixed(2)}s
                  </span>
                </div>
                <canvas
                  ref={snapshotCanvasARef}
                  data-testid="snapshot-canvas-a"
                  width={320}
                  height={180}
                  className="mt-2 aspect-video w-full rounded-lg border border-slate-800 bg-slate-950"
                />
                <div className="mt-2 flex items-center justify-between text-xs text-slate-300 font-mono">
                  <span>
                    {snapshotSampleA.speedKmh.toFixed(1)} km/h (&plusmn;{snapshotSampleA.speedUncertaintyKmh.toFixed(1)})
                  </span>
                  <span>
                    Offset: {snapshotGate.horizontalOffsetMeters}m | {snapshotGate.angleDeg}&deg;
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-slate-950/70 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-400">
                    {athleteB.athleteName}
                  </span>
                  <span className="font-mono text-xs font-bold text-white tabular-nums">
                    {snapshotSampleB.elapsedTimeSec.toFixed(2)}s (
                    {snapshotSampleA.elapsedTimeSec - snapshotSampleB.elapsedTimeSec <= 0
                      ? `+${(snapshotSampleB.elapsedTimeSec - snapshotSampleA.elapsedTimeSec).toFixed(2)}s`
                      : `-${(snapshotSampleA.elapsedTimeSec - snapshotSampleB.elapsedTimeSec).toFixed(2)}s`}
                    )
                  </span>
                </div>
                <canvas
                  ref={snapshotCanvasBRef}
                  data-testid="snapshot-canvas-b"
                  width={320}
                  height={180}
                  className="mt-2 aspect-video w-full rounded-lg border border-slate-800 bg-slate-950"
                />
                <div className="mt-2 flex items-center justify-between text-xs text-slate-300 font-mono">
                  <span>
                    {snapshotSampleB.speedKmh.toFixed(1)} km/h (&plusmn;{snapshotSampleB.speedUncertaintyKmh.toFixed(1)})
                  </span>
                  <span>
                    Offset: {snapshotGate.horizontalOffsetMeters}m | {snapshotGate.angleDeg}&deg;
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950/80 p-3 text-xs text-slate-300 border border-slate-800">
              <span className="font-semibold text-cyan-400">Coaching Note:</span> In Spatial-Ghost Sync mode, athletes enter Gate {snapshotGate.gateNumber} simultaneously on screen to compare turn initiation timing, hip angulation, and exit speed trajectory.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
