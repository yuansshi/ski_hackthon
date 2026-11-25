import React from 'react';
import type { CoachingHighlight } from '../../shared/types.js';

export interface CoachingSummaryPanelProps {
  highlights: CoachingHighlight[];
  onSeekToProgress: (s: number) => void;
  onOpenSnapshot: (gateNumber: number) => void;
  hasGpsCourseMap: boolean;
}

export const CoachingSummaryPanel: React.FC<CoachingSummaryPanelProps> = ({
  highlights,
  onSeekToProgress,
  onOpenSnapshot,
  hasGpsCourseMap,
}) => {
  return (
    <div
      data-testid="coaching-summary-panel"
      className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 brand-font">
            Coaching Insights &amp; Attribution
          </span>
          <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-bold text-cyan-400 border border-cyan-500/30">
            {highlights.length} Major Time Swings
          </span>
        </div>
        <span className="text-xs text-slate-500">
          Decomposed into Turn Execution Tax vs. Glide Carry
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {highlights.map((item, index) => {
          const isAhead = item.timeSwingSec < 0;
          const absSwing = Math.abs(item.timeSwingSec).toFixed(2);
          const absTurn = Math.abs(item.turnExecutionDeltaSec).toFixed(2);
          const absGlide = Math.abs(item.glideCarryDeltaSec).toFixed(2);

          const badgeColor = isAhead
            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
            : 'bg-rose-500/20 text-rose-400 border-rose-500/40';

          // Derive approximate gate number from startProgress if course map is available
          const approxGate = Math.max(1, Math.min(38, Math.round(item.startProgress * 38)));

          return (
            <div
              key={item.id}
              data-testid={`coaching-highlight-card-${index}`}
              className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 transition hover:border-slate-700 hover:bg-slate-950"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-400">
                      {item.sectionLabel}
                    </span>
                    <h4 className="mt-1.5 text-xs font-bold text-white leading-snug">
                      {item.title}
                    </h4>
                  </div>
                  <span
                    className={`rounded-md border px-2 py-0.5 font-mono text-xs font-bold tabular-nums shrink-0 ${badgeColor}`}
                  >
                    {isAhead ? `-${absSwing}s` : `+${absSwing}s`}
                  </span>
                </div>

                {/* Turn vs Glide Breakdown Pills */}
                <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <div className="flex items-center gap-1 rounded bg-slate-800/80 px-2 py-0.5 text-slate-300 border border-slate-700/60">
                    <span className="text-slate-400">Turn Tax:</span>
                    <span className="font-bold text-amber-400">{absTurn}s</span>
                  </div>
                  <div className="flex items-center gap-1 rounded bg-slate-800/80 px-2 py-0.5 text-slate-300 border border-slate-700/60">
                    <span className="text-slate-400">Glide Carry:</span>
                    <span className="font-bold text-cyan-400">{absGlide}s</span>
                  </div>
                </div>

                <div className="mt-2 text-[10px] text-slate-500 font-mono">
                  {item.provenance} &bull; &Delta;v exit{' '}
                  {item.exitSpeedDiffKmh >= 0 ? `+${item.exitSpeedDiffKmh.toFixed(1)}` : item.exitSpeedDiffKmh.toFixed(1)} km/h
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-3.5 flex items-center gap-2 border-t border-slate-800/80 pt-2.5">
                <button
                  data-testid={`jump-to-section-btn-${index}`}
                  onClick={() => onSeekToProgress(item.startProgress)}
                  className="flex-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 active:scale-95 text-center"
                >
                  Jump to Section
                </button>
                {hasGpsCourseMap && (
                  <button
                    data-testid={`gate-snapshot-btn-${index}`}
                    onClick={() => onOpenSnapshot(approxGate)}
                    className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/20 active:scale-95"
                    title="View Gate Split Snapshot comparison"
                  >
                    Gate Snapshot
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
