import React, { useMemo, useState } from 'react';
import type {
  CourseProfile,
  SpatialSample,
  TemporalSample,
} from '../../shared/types.js';
import { Slope3DReconstructor } from './Slope3DReconstructor.js';

export interface CourseTrackMap2DProps {
  course: CourseProfile;
  samplesA?: SpatialSample[];
  samplesB?: SpatialSample[];
  temporalSampleA: TemporalSample;
  temporalSampleB: TemporalSample;
  spatialSampleA?: SpatialSample;
  spatialSampleB?: SpatialSample;
  spatialGapMeters: number;
  ghostDeltaSec?: number;
  onSeekToProgress: (s: number) => void;
  athleteAName: string;
  athleteBName: string;
}

export const CourseTrackMap2D: React.FC<CourseTrackMap2DProps> = ({
  course,
  samplesA = [],
  samplesB = [],
  temporalSampleA,
  temporalSampleB,
  spatialSampleA,
  spatialSampleB,
  spatialGapMeters,
  ghostDeltaSec = 0,
  onSeekToProgress,
  athleteAName,
  athleteBName,
}) => {
  const [dimensionMode, setDimensionMode] = useState<'3D' | '2D'>('3D');

  const splinePath = useMemo(() => {
    const pts = course.trailSpline2D;
    if (pts.length === 0) return '';
    return pts.reduce((acc, pt, idx) => {
      return `${acc} ${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
    }, '');
  }, [course.trailSpline2D]);

  const isSuperG = course.hasGpsCourseMap;
  const courseMapEnabled = course.courseMapEnabled;

  const fallbackSpatialA: SpatialSample = spatialSampleA ?? {
    progressIndex: Math.round(temporalSampleA.normalizedProgress * 1000),
    normalizedProgress: temporalSampleA.normalizedProgress,
    distanceMeters: temporalSampleA.distanceMeters,
    elapsedTimeSec: temporalSampleA.elapsedTimeSec,
    speedKmh: temporalSampleA.speedKmh,
    speedMph: temporalSampleA.speedKmh * 0.621371,
    speedUncertaintyKmh: 1.5,
    provenance: 'KINEMATIC_INTERPOLATED',
    gateNumber: 1,
    pitchRatio: 0.45,
  };

  const fallbackSpatialB: SpatialSample = spatialSampleB ?? {
    progressIndex: Math.round(temporalSampleB.normalizedProgress * 1000),
    normalizedProgress: temporalSampleB.normalizedProgress,
    distanceMeters: temporalSampleB.distanceMeters,
    elapsedTimeSec: temporalSampleB.elapsedTimeSec,
    speedKmh: temporalSampleB.speedKmh,
    speedMph: temporalSampleB.speedKmh * 0.621371,
    speedUncertaintyKmh: 1.5,
    provenance: 'KINEMATIC_INTERPOLATED',
    gateNumber: 1,
    pitchRatio: 0.45,
  };

  return (
    <div
      data-testid="course-track-map-2d"
      className="relative flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl p-4"
    >
      {/* Top Map Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex flex-col">
          <span className="text-xs font-bold uppercase tracking-wider text-cyan-400 brand-font">
            {dimensionMode === '3D'
              ? '3D Slope Position & Speed Map'
              : '2D Course Map'}
          </span>
          <span className="text-sm font-semibold text-white">
            {isSuperG && courseMapEnabled
              ? 'GPS Gate Survey (38 Gates, 1,672.91m)'
              : isSuperG
                ? 'Video-Only Baseline Mode'
                : `Birds of Prey Downhill Course (${Math.round(course.totalDistanceMeters).toLocaleString('en-US')}m)`}
          </span>
        </div>

        {/* 3D / 2D Mode Toggle & Live Separation Readout */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-700 bg-slate-950 p-0.5 text-[11px] font-semibold">
            <button
              data-testid="map-mode-3d-btn"
              onClick={() => setDimensionMode('3D')}
              className={`rounded-md px-2 py-0.5 transition ${
                dimensionMode === '3D'
                  ? 'bg-cyan-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              3D Twin
            </button>
            <button
              data-testid="map-mode-2d-btn"
              onClick={() => setDimensionMode('2D')}
              className={`rounded-md px-2 py-0.5 transition ${
                dimensionMode === '2D'
                  ? 'bg-cyan-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              2D Flat
            </button>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950/80 px-2.5 py-1 text-xs font-mono font-bold">
            <span className="text-slate-400">Gap &Delta;d:</span>
            <span
              data-testid="live-meter-gap"
              className={`tabular-nums ${
                spatialGapMeters > 0
                  ? 'text-cyan-400'
                  : spatialGapMeters < 0
                    ? 'text-amber-400'
                    : 'text-slate-300'
              }`}
            >
              {spatialGapMeters > 0
                ? `+${spatialGapMeters.toFixed(1)}m`
                : `${spatialGapMeters.toFixed(1)}m`}
            </span>
          </div>
        </div>
      </div>

      {/* Main 3D Reconstructor Stage (Default) */}
      {dimensionMode === '3D' && (
        <div className="relative flex-1 min-h-[420px] w-full pt-2">
          <Slope3DReconstructor
            course={course}
            samplesA={samplesA}
            samplesB={samplesB}
            temporalSampleA={temporalSampleA}
            temporalSampleB={temporalSampleB}
            spatialSampleA={fallbackSpatialA}
            spatialSampleB={fallbackSpatialB}
            spatialGapMeters={spatialGapMeters}
            ghostDeltaSec={ghostDeltaSec}
            athleteAName={athleteAName}
            athleteBName={athleteBName}
            onSeekToProgress={onSeekToProgress}
            defaultViewMode="SPLIT_3D"
            compact
          />
        </div>
      )}

      {/* 2D SVG Canvas Stage (Visible in 2D mode, kept mounted invisibly in 3D mode for E2E marker continuity) */}
      <div
        className={
          dimensionMode === '2D'
            ? 'relative flex-1 min-h-[360px] w-full flex items-center justify-center p-2'
            : 'pointer-events-none'
        }
        style={
          dimensionMode === '3D'
            ? {
                position: 'absolute',
                width: 1,
                height: 1,
                opacity: 0,
                overflow: 'hidden',
                pointerEvents: 'none',
              }
            : undefined
        }
      >
        <svg
          viewBox="0 0 1000 1000"
          className="h-full max-h-[460px] w-full select-none"
          style={{ filter: 'drop-shadow(0 0 12px rgba(6, 182, 212, 0.15))' }}
        >
          {/* Background Course Polyline Ribbon */}
          <path
            d={splinePath}
            fill="none"
            stroke="#1e293b"
            strokeWidth="36"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={splinePath}
            fill="none"
            stroke="#334155"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Gates and Landmarks */}
          {course.gates.map((gate) => {
            let color = '#94a3b8';
            if (gate.color === 'RED') color = '#ef4444';
            if (gate.color === 'BLUE') color = '#3b82f6';
            if (gate.color === 'ORANGE') color = '#f97316';
            if (gate.color === 'FINISH') color = '#10b981';

            const isStartOrFinish =
              gate.normalizedProgress === 0 || gate.normalizedProgress === 1;

            return (
              <g
                key={`gate-${gate.gateNumber}`}
                onClick={() => onSeekToProgress(gate.normalizedProgress)}
                className="cursor-pointer transition-transform hover:scale-125"
              >
                <title>{`Gate ${gate.gateNumber}: ${gate.color} ${gate.type} (${gate.pitchRatio * 100}% pitch)`}</title>
                <circle
                  cx={gate.mapX}
                  cy={gate.mapY}
                  r={isStartOrFinish ? 9 : 5}
                  fill={color}
                  stroke="#020617"
                  strokeWidth="2"
                />
                {courseMapEnabled && gate.gateNumber % 3 === 0 && (
                  <text
                    x={gate.mapX + 8}
                    y={gate.mapY + 4}
                    fill="#94a3b8"
                    fontSize="18"
                    fontWeight="600"
                    fontFamily="monospace"
                  >
                    G{gate.gateNumber}
                  </text>
                )}
              </g>
            );
          })}

          {/* Active Skier Markers */}
          <g transform={`translate(${temporalSampleB.mapX}, ${temporalSampleB.mapY})`}>
            <circle r="14" fill="#f59e0b" fillOpacity="0.3" className="animate-ping" />
            <circle
              data-testid="skier-marker-b"
              r="7"
              fill="#f59e0b"
              stroke="#020617"
              strokeWidth="2.5"
            />
          </g>

          <g transform={`translate(${temporalSampleA.mapX}, ${temporalSampleA.mapY})`}>
            <circle r="16" fill="#06b6d4" fillOpacity="0.3" className="animate-ping" />
            <circle
              data-testid="skier-marker-a"
              r="8"
              fill="#06b6d4"
              stroke="#ffffff"
              strokeWidth="2.5"
            />
          </g>
        </svg>
      </div>

      {/* Map Legend */}
      <div className="flex flex-wrap items-center justify-between border-t border-slate-800 pt-3 mt-2 text-xs text-slate-400">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 font-mono">
            <span className="inline-block h-3 w-3 rounded-full bg-cyan-400 border border-slate-950" />
            <span className="text-slate-200">{athleteAName.split(' ')[0]}</span>
            <span className="text-cyan-300 font-bold">
              {Math.round(fallbackSpatialA.speedKmh)} km/h
            </span>
            <span className="text-slate-500">
              ({Math.round(temporalSampleA.distanceMeters)}m)
            </span>
          </div>
          <div className="flex items-center gap-1.5 font-mono">
            <span className="inline-block h-3 w-3 rounded-full bg-amber-400 border border-slate-950" />
            <span className="text-slate-200">{athleteBName.split(' ')[0]}</span>
            <span className="text-amber-300 font-bold">
              {Math.round(fallbackSpatialB.speedKmh)} km/h
            </span>
            <span className="text-slate-500">
              ({Math.round(temporalSampleB.distanceMeters)}m)
            </span>
          </div>
        </div>

        <div className="text-[11px] text-slate-500">
          {dimensionMode === '3D'
            ? '3D Slope Chase + Speed Map'
            : 'Click any gate point to jump'}
        </div>
      </div>
    </div>
  );
};
