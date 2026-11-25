import React, { useMemo, useRef } from 'react';
import type { SpatialSample } from '../../shared/types.js';

export interface TelemetryTraceChartProps {
  samplesA: SpatialSample[];
  samplesB: SpatialSample[];
  currentProgress: number;
  onSeekToProgress: (s: number) => void;
  athleteAName: string;
  athleteBName: string;
}

export const TelemetryTraceChart: React.FC<TelemetryTraceChartProps> = ({
  samplesA,
  samplesB,
  currentProgress,
  onSeekToProgress,
  athleteAName,
  athleteBName,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointer = (
    e: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>
  ) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const s = x / rect.width;
    onSeekToProgress(s);
  };

  // Build SVG polyline points for Speed and Delta
  const { speedPointsA, speedPointsB, deltaPoints, deltaAreaGreen, deltaAreaRed } =
    useMemo(() => {
      const step = 2; // sample every 2 ticks (500 pts) for smooth fast rendering
      const width = 1000;
      const height = 140;
      const zeroDeltaY = 100; // y coordinate corresponding to delta = 0

      let sPtsA = '';
      let sPtsB = '';
      let dPts = '';
      let greenAreaD = `M 0 ${zeroDeltaY}`;
      let redAreaD = `M 0 ${zeroDeltaY}`;

      for (let i = 0; i <= 1000; i += step) {
        const s = i / 1000;
        const x = s * width;

        const a = samplesA[i];
        const b = samplesB[i];

        // Speed maps from [20 km/h, 140 km/h] to [height, 0]
        const speedNormA = Math.max(0, Math.min(1, (a.speedKmh - 20) / 120));
        const yA = height - speedNormA * (height - 10);
        sPtsA += `${i === 0 ? '' : ' '}${x.toFixed(1)},${yA.toFixed(1)}`;

        const speedNormB = Math.max(0, Math.min(1, (b.speedKmh - 20) / 120));
        const yB = height - speedNormB * (height - 10);
        sPtsB += `${i === 0 ? '' : ' '}${x.toFixed(1)},${yB.toFixed(1)}`;

        // Delta t(s) = t_A(s) - t_B(s). Map [-1.0s, +1.0s] around zeroDeltaY
        const delta = a.elapsedTimeSec - b.elapsedTimeSec;
        const deltaClamped = Math.max(-1.0, Math.min(1.0, delta));
        const deltaY = zeroDeltaY + deltaClamped * 35; // positive = lower on chart (red)
        dPts += `${i === 0 ? '' : ' '}${x.toFixed(1)},${deltaY.toFixed(1)}`;

        if (delta < 0) {
          greenAreaD += ` L ${x.toFixed(1)} ${deltaY.toFixed(1)}`;
        } else {
          greenAreaD += ` L ${x.toFixed(1)} ${zeroDeltaY}`;
        }

        if (delta > 0) {
          redAreaD += ` L ${x.toFixed(1)} ${deltaY.toFixed(1)}`;
        } else {
          redAreaD += ` L ${x.toFixed(1)} ${zeroDeltaY}`;
        }
      }

      greenAreaD += ` L ${width} ${zeroDeltaY} Z`;
      redAreaD += ` L ${width} ${zeroDeltaY} Z`;

      return {
        speedPointsA: sPtsA,
        speedPointsB: sPtsB,
        deltaPoints: dPts,
        deltaAreaGreen: greenAreaD,
        deltaAreaRed: redAreaD,
      };
    }, [samplesA, samplesB]);

  const playheadXPercent = Math.max(0, Math.min(100, currentProgress * 100));

  return (
    <div
      data-testid="telemetry-trace-chart"
      className="relative flex flex-col rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl"
    >
      {/* Chart Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 brand-font">
            Telemetry Trace
          </span>
          <span className="text-xs text-slate-500">
            (Speed curves &amp; Ghost Delta &Delta;t(s) along course progress)
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-cyan-400" />
            <span className="text-slate-300">{athleteAName.split(' ')[0]} Speed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-amber-400" />
            <span className="text-slate-300">{athleteBName.split(' ')[0]} Speed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-emerald-400" />
            <span className="text-emerald-400">&Delta;t Ahead</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-rose-400" />
            <span className="text-rose-400">&Delta;t Behind</span>
          </div>
        </div>
      </div>

      {/* Interactive Scrubbing Surface */}
      <div
        ref={containerRef}
        data-testid="telemetry-scrub-surface"
        onClick={handlePointer}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {}
          handlePointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0) handlePointer(e);
        }}
        className="relative mt-2 h-36 w-full cursor-ew-resize select-none overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950"
      >
        <svg
          viewBox="0 0 1000 140"
          preserveAspectRatio="none"
          className="h-full w-full pointer-events-none"
        >
          {/* Reference Zero Delta Gridline */}
          <line
            x1="0"
            y1="100"
            x2="1000"
            y2="100"
            stroke="#334155"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {/* Shaded Delta Areas */}
          <path d={deltaAreaGreen} fill="#10b981" fillOpacity="0.25" />
          <path d={deltaAreaRed} fill="#ef4444" fillOpacity="0.25" />

          {/* Athlete B Speed Line (Amber) */}
          <polyline
            points={speedPointsB}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeOpacity="0.75"
          />

          {/* Athlete A Speed Line (Cyan) */}
          <polyline
            points={speedPointsA}
            fill="none"
            stroke="#06b6d4"
            strokeWidth="2.5"
          />

          {/* Ghost Delta Line */}
          <polyline
            points={deltaPoints}
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </svg>

        {/* Synchronized Vertical Playhead Line */}
        <div
          data-testid="trace-playhead"
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]"
          style={{ left: `${playheadXPercent}%` }}
        >
          <div className="absolute -top-1 -left-1.5 h-3 w-3 rounded-full bg-cyan-400 border border-white" />
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 font-mono">
        <span>Start (s = 0.0)</span>
        <span>Middle Section (s = 0.5)</span>
        <span>Finish Beam (s = 1.0)</span>
      </div>
    </div>
  );
};
