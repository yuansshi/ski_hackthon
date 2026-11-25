import React, { useEffect, useState } from 'react';
import type {
  AnchorOverrideRecord,
  RaceCatalogItem,
  RaceComparisonManifest,
} from '../shared/types.js';
import { solveRaceComparisonManifest } from '../shared/kinematic-solver.js';
import { useTelemetrySync } from './hooks/useTelemetrySync.js';
import { VideoTelemetryStage } from './components/VideoTelemetryStage.js';
import { MicroSectorBar } from './components/MicroSectorBar.js';
import { CourseTrackMap2D } from './components/CourseTrackMap2D.js';
import { TelemetryTraceChart } from './components/TelemetryTraceChart.js';
import { CoachingSummaryPanel } from './components/CoachingSummaryPanel.js';
import { AnchorCalibrationDrawer } from './components/AnchorCalibrationDrawer.js';
import { ComparisonFilm } from './components/ComparisonFilm.js';
import { AnalyzeDownhill } from './components/AnalyzeDownhill.js';

export function App() {
  const view = new URLSearchParams(window.location.search).get('view');

  return (
    <>
      <nav className="comparison-nav" aria-label="Alpine telemetry">
        <a className="comparison-brand" href="/">Alpine Race Telemetry</a>
        <div>
          <a href="/" aria-current={view === 'reference' || view === 'analyze' ? undefined : 'page'}>Beaver Creek comparison</a>
          <a href="/?view=analyze" aria-current={view === 'analyze' ? 'page' : undefined}>Analyze footage</a>
          <a href="/?view=reference" aria-current={view === 'reference' ? 'page' : undefined}>GNSS reference</a>
        </div>
      </nav>
      {view === 'reference' ? <TelemetryReference /> : view === 'analyze' ? <AnalyzeDownhill /> : <ComparisonFilm />}
    </>
  );
}

const TelemetryReference: React.FC = () => {
  const [races, setRaces] = useState<RaceCatalogItem[]>([]);
  const [selectedRaceId, setSelectedRaceId] = useState<string>('beaver-creek-men-dh-2025');
  const [manifest, setManifest] = useState<RaceComparisonManifest | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // View state
  const [comparisonMode, setComparisonMode] = useState<'PRIMARY_RUN' | 'SIDE_BY_SIDE'>('SIDE_BY_SIDE');
  const [syncMode, setSyncMode] = useState<'RACE_CLOCK' | 'SPATIAL_GHOST'>('SPATIAL_GHOST');
  const [playbackSpeed, setPlaybackSpeed] = useState<0.5 | 1 | 2>(1);
  const [courseMapEnabled, setCourseMapEnabled] = useState<boolean>(true);
  const [snapshotGateNumber, setSnapshotGateNumber] = useState<number | null>(null);
  const [isCalibrationOpen, setIsCalibrationOpen] = useState<boolean>(false);

  // Fetch races catalog
  useEffect(() => {
    fetch('/api/races')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RaceCatalogItem[]>;
      })
      .then((data) => setRaces(data))
      .catch((err) => console.error('Failed to load races catalog', err));
  }, []);

  // Fetch race manifest when selectedRaceId changes
  useEffect(() => {
    setIsLoading(true);
    setError(null);
    fetch(`/api/races/${selectedRaceId}/manifest?courseMap=${courseMapEnabled}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RaceComparisonManifest>;
      })
      .then((data) => {
        setManifest(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(`Failed to load race manifest: ${err.message}`);
        setIsLoading(false);
      });
  }, [selectedRaceId, courseMapEnabled]);

  // Hook sync logic
  const syncState = useTelemetrySync(
    manifest ?? {
      raceId: 'empty',
      courseProfile: {
        raceId: 'empty',
        discipline: 'super-g',
        title: 'Loading',
        sourceVideoFilename: '',
        feedType: 'CLN_F',
        hasGpsCourseMap: false,
        courseMapEnabled: false,
        totalDistanceMeters: 1000,
        totalVerticalDropMeters: 500,
        gates: [],
        trailSpline2D: [],
      },
      athleteA: {
        athleteId: 'a',
        athleteName: 'Athlete A',
        bibNumber: 1,
        countryCode: 'USA',
        clipUrl: '',
        startClipOffsetSec: 0,
        totalTimeSec: 60,
        nativeFps: 29.97,
        anchors: [],
        samplesByProgress: [],
        samplesByTime: [],
      },
      athleteB: {
        athleteId: 'b',
        athleteName: 'Athlete B',
        bibNumber: 2,
        countryCode: 'SUI',
        clipUrl: '',
        startClipOffsetSec: 0,
        totalTimeSec: 60,
        nativeFps: 29.97,
        anchors: [],
        samplesByProgress: [],
        samplesByTime: [],
      },
      microSectors: [],
      coachingHighlights: [],
    },
    playbackSpeed,
    syncMode
  );

  // Live client-side re-solve for interactive drawer frame nudges (< 2ms)
  const handleApplyClientOverrides = (overrides: AnchorOverrideRecord[]) => {
    if (!manifest) return;
    const reSolved = solveRaceComparisonManifest(manifest, overrides, courseMapEnabled);
    setManifest(reSolved);
  };

  // Persist to Cloudflare D1
  const handleSaveToD1 = async (overrides: AnchorOverrideRecord[]) => {
    if (!manifest) return;
    const res = await fetch(`/api/races/${manifest.raceId}/anchors`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        athleteId: overrides[0]?.athleteId ?? manifest.athleteB.athleteId,
        overrides: overrides.map((o) => ({
          anchorId: o.anchorId,
          videoTimestampSec: o.videoTimestampSec,
        })),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const updated = (await res.json()) as RaceComparisonManifest;
    setManifest(updated);
  };

  // Reset to baseline in Cloudflare D1
  const handleResetBaseline = async () => {
    if (!manifest) return;
    const res = await fetch(`/api/races/${manifest.raceId}/anchors`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const resetManifest = (await res.json()) as RaceComparisonManifest;
    setManifest(resetManifest);
  };

  // CUJ 3 toggle handler
  const handleToggleCourseMap = () => {
    const nextVal = !courseMapEnabled;
    setCourseMapEnabled(nextVal);
    if (manifest && manifest.courseProfile.hasGpsCourseMap) {
      const solved = solveRaceComparisonManifest(manifest, [], nextVal);
      setManifest(solved);
    }
  };

  if (isLoading && !manifest) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-cyan-400">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-cyan-400 border-t-transparent" />
          <span className="font-mono text-sm">Loading Alpine Race Telemetry...</span>
        </div>
      </div>
    );
  }

  if (error && !manifest) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 p-6 text-rose-400">
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 max-w-md text-center">
          <h2 className="text-lg font-bold">Failed to Initialize Application</h2>
          <p className="mt-2 text-sm text-slate-300">{error}</p>
        </div>
      </div>
    );
  }

  if (!manifest) return null;

  const isSuperG = manifest.courseProfile.hasGpsCourseMap;

  return (
    <div className="app-container min-h-screen">
      {/* Top Application Header Bar */}
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-2.5 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 text-slate-950 shadow-lg shadow-cyan-500/20">
            <svg className="h-6 w-6 fill-current" viewBox="0 0 24 24">
              <path d="M14 6l-3.8 8.4-2.2-3.4L3 17h18L14 6z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tight text-white brand-font">
                Alpine Race Telemetry Coach
              </h1>
              {manifest.isSyntheticDemo ? (
                <span
                  data-testid="synthetic-demo-banner"
                  className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300 border border-amber-500/40"
                >
                  Simulated Demo
                </span>
              ) : (
                <span
                  data-testid="real-telemetry-banner"
                  className="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/40"
                  title={manifest.provenanceDisclosure}
                >
                  GNSS reference · approximate video sync
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono">
              {manifest.athleteA.athleteName} ({manifest.athleteA.totalTimeSec.toFixed(2)}s) vs.{' '}
              {manifest.athleteB.athleteName} ({manifest.athleteB.totalTimeSec.toFixed(2)}s)
            </p>
          </div>
        </div>

        {/* Global Selectors */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Race Selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="race-select" className="text-xs font-semibold text-slate-400">
              Discipline:
            </label>
            <select
              id="race-select"
              data-testid="race-selector"
              value={selectedRaceId}
              onChange={(e) => setSelectedRaceId(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-bold text-white shadow-sm outline-none transition focus:border-cyan-400"
            >
              {races.length > 0 ? (
                races.map((r) => (
                  <option key={r.raceId} value={r.raceId}>
                    {r.title}
                  </option>
                ))
              ) : (
                <>
                  <option value="beaver-creek-men-sg-2025">Beaver Creek Men's Super-G</option>
                  <option value="beaver-creek-men-dh-2025">Beaver Creek Men's Downhill</option>
                </>
              )}
            </select>
          </div>

          {/* Super-G GPS Course Map Enhancement Toggle (CUJ 3) */}
          {isSuperG && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-1">
              <span className="text-xs text-slate-300 font-semibold">GPS Enhancement:</span>
              <button
                data-testid="toggle-gps-enhancement-btn"
                onClick={handleToggleCourseMap}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  courseMapEnabled ? 'bg-cyan-500' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    courseMapEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <span className="font-mono text-xs text-slate-400">
                {courseMapEnabled ? 'GPS Active' : 'Video Baseline'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* Top Micro-Sector Ribbon */}
      <MicroSectorBar
        microSectors={manifest.microSectors}
        currentProgress={syncState.normalizedProgress}
        onSelectSector={(s) => syncState.seekToProgress(s)}
      />

      {/* Main Analysis Stage: Video Screen (Left) + 2D Animated Map (Right) */}
      <main className="stage-grid">
        <VideoTelemetryStage
          manifest={manifest}
          syncState={syncState}
          comparisonMode={comparisonMode}
          onChangeComparisonMode={setComparisonMode}
          syncMode={syncMode}
          onChangeSyncMode={setSyncMode}
          playbackSpeed={playbackSpeed}
          onChangePlaybackSpeed={setPlaybackSpeed}
          snapshotGateNumber={snapshotGateNumber}
          onCloseSnapshot={() => setSnapshotGateNumber(null)}
          onOpenCalibration={() => setIsCalibrationOpen(true)}
        />

        <CourseTrackMap2D
          course={manifest.courseProfile}
          samplesA={manifest.athleteA.samplesByProgress}
          samplesB={manifest.athleteB.samplesByProgress}
          temporalSampleA={syncState.currentTemporalSampleA}
          temporalSampleB={syncState.currentTemporalSampleB}
          spatialSampleA={syncState.currentSpatialSampleA}
          spatialSampleB={syncState.currentSpatialSampleB}
          spatialGapMeters={syncState.spatialGapMeters}
          ghostDeltaSec={syncState.ghostDeltaSec}
          onSeekToProgress={(s) => syncState.seekToProgress(s)}
          athleteAName={manifest.athleteA.athleteName}
          athleteBName={manifest.athleteB.athleteName}
        />
      </main>

      {/* Synchronized Telemetry Trace Chart */}
      <section>
        <TelemetryTraceChart
          samplesA={manifest.athleteA.samplesByProgress}
          samplesB={manifest.athleteB.samplesByProgress}
          currentProgress={syncState.normalizedProgress}
          onSeekToProgress={(s) => syncState.seekToProgress(s)}
          athleteAName={manifest.athleteA.athleteName}
          athleteBName={manifest.athleteB.athleteName}
        />
      </section>

      {/* Automated Coaching Takeaways & Turn Tax vs Glide Carry Decomposition */}
      <section>
        <CoachingSummaryPanel
          highlights={manifest.coachingHighlights}
          onSeekToProgress={(s) => {
            syncState.seekToProgress(s);
            setSyncMode('SPATIAL_GHOST');
            setComparisonMode('SIDE_BY_SIDE');
          }}
          onOpenSnapshot={(gate) => {
            syncState.pause();
            setSnapshotGateNumber(gate);
            setSyncMode('SPATIAL_GHOST');
            setComparisonMode('SIDE_BY_SIDE');
          }}
          hasGpsCourseMap={isSuperG}
        />
      </section>

      {/* Live Anchor Inspection & Calibration Drawer (CUJ 4) */}
      <AnchorCalibrationDrawer
        isOpen={isCalibrationOpen}
        onClose={() => setIsCalibrationOpen(false)}
        manifest={manifest}
        onApplyClientOverrides={handleApplyClientOverrides}
        onSaveToD1={handleSaveToD1}
        onResetFactoryBaseline={handleResetBaseline}
      />
    </div>
  );
};
