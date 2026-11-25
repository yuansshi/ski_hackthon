import React from 'react';
import type { DataProvenance, SpatialSample } from '../../shared/types.js';

export interface F1GhostHudProps {
  elapsedTimeSec: number;
  sampleA: SpatialSample;
  sampleB: SpatialSample;
  ghostDeltaSec: number;
  courseMapEnabled: boolean;
  athleteAName: string;
  athleteBName: string;
  isSyntheticDemo?: boolean;
}

function formatRaceTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m > 0 ? `${m}:` : ''}${s < 10 && m > 0 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`;
}

function getProvenanceBadgeClass(prov: DataProvenance): string {
  switch (prov) {
    case 'OCR_MEASURED':
      return 'badge-ocr';
    case 'GNSS_DERIVED':
    case 'GATE_CALIBRATED':
      return 'badge-gate';
    case 'MANUALLY_ANNOTATED':
      return 'badge-manual';
    case 'SIMULATED':
    case 'KINEMATIC_INTERPOLATED':
    default:
      return 'badge-interp';
  }
}

function formatProvenanceLabel(prov: DataProvenance): string {
  switch (prov) {
    case 'OCR_MEASURED':
      return 'OCR Measured';
    case 'GNSS_DERIVED':
      return 'GNSS Derived';
    case 'GATE_CALIBRATED':
      return 'Gate-Calibrated';
    case 'MANUALLY_ANNOTATED':
      return 'Manually Annotated';
    case 'SIMULATED':
      return 'Simulated';
    case 'KINEMATIC_INTERPOLATED':
    default:
      return 'Kinematic Interpolated';
  }
}

export const F1GhostHud: React.FC<F1GhostHudProps> = ({
  elapsedTimeSec,
  sampleA,
  sampleB,
  ghostDeltaSec,
  courseMapEnabled,
  athleteAName,
  athleteBName,
  isSyntheticDemo,
}) => {
  const isAhead = ghostDeltaSec < -0.005;
  const isBehind = ghostDeltaSec > 0.005;
  const provenance = isSyntheticDemo && sampleA.provenance !== 'MANUALLY_ANNOTATED'
    ? 'SIMULATED'
    : sampleA.provenance;

  const deltaFormatted = Math.abs(ghostDeltaSec).toFixed(2);
  const deltaBadgeText = isAhead
    ? `-${deltaFormatted}s AHEAD`
    : isBehind
      ? `+${deltaFormatted}s BEHIND`
      : `0.00s EVEN`;

  const deltaBgColor = isAhead
    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
    : isBehind
      ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
      : 'bg-slate-500/20 text-slate-300 border-slate-500/40';

  return (
    <div
      data-testid="f1-ghost-hud"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/90 px-4 py-2.5 backdrop-blur-md"
    >
      {/* Left: Race Clock & Ghost Time Delta */}
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-1.5 font-mono">
          <span className="text-xs font-bold uppercase text-cyan-400">
            {athleteAName.split(' ')[0]}
          </span>
          <span className="text-xl font-black tracking-tight text-white tabular-nums">
            {formatRaceTime(elapsedTimeSec)}
          </span>
        </div>
        <div
          data-testid="ghost-delta-badge"
          className={`rounded-md border px-2.5 py-0.5 font-mono text-xs font-bold tabular-nums tracking-wide ${deltaBgColor}`}
        >
          {deltaBadgeText}
        </div>
      </div>

      {/* Center: Speedometer & Comparison Speed */}
      <div className="flex items-center gap-3 font-mono">
        <div className="flex items-baseline gap-1">
          <span className="text-xl font-black text-cyan-400 tabular-nums">
            {Math.round(sampleA.speedKmh)}
          </span>
          <span className="text-xs font-semibold text-slate-400">km/h</span>
          <span className="text-xs text-slate-500 tabular-nums">
            ({Math.round(sampleA.speedMph)} mph)
          </span>
        </div>
        <span className="text-[11px] text-slate-400 tabular-nums">
          vs {athleteBName.split(' ')[0]}{' '}
          <strong className="text-amber-400">{Math.round(sampleB.speedKmh)} km/h</strong>
        </span>
        <span className="text-[10px] text-slate-500 tabular-nums">
          (&plusmn;{sampleA.speedUncertaintyKmh.toFixed(1)} km/h)
        </span>
      </div>

      {/* Right: GPS Gate/Pitch Pill & Provenance Badge */}
      <div className="flex items-center gap-2">
        {courseMapEnabled && sampleA.gateNumber !== null && (
          <div
            data-testid="gps-gate-pill"
            className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-0.5 text-xs font-mono text-slate-300"
          >
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-cyan-400"></span>
              <span>Gate {sampleA.gateNumber}</span>
            </span>
            <span className="text-slate-400">
              Pitch {Math.round(sampleA.pitchRatio * 100)}%
            </span>
          </div>
        )}

        <span
          data-testid="provenance-badge"
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${getProvenanceBadgeClass(
            provenance
          )}`}
        >
          {formatProvenanceLabel(provenance)}
        </span>
      </div>
    </div>
  );
};
