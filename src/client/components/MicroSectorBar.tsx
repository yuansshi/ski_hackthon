import React from 'react';
import type { MicroSectorComparison } from '../../shared/types.js';

export interface MicroSectorBarProps {
  microSectors: MicroSectorComparison[];
  currentProgress: number;
  onSelectSector: (startProgress: number) => void;
}

export const MicroSectorBar: React.FC<MicroSectorBarProps> = ({
  microSectors,
  currentProgress,
  onSelectSector,
}) => {
  return (
    <div
      data-testid="micro-sector-bar"
      className="flex w-full items-stretch gap-1.5 rounded-xl border border-slate-800 bg-slate-950/80 p-2 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center px-2 text-xs font-bold uppercase tracking-wider text-slate-400 brand-font">
        Sectors
      </div>
      <div className="flex flex-1 items-stretch gap-1.5 overflow-x-auto">
        {microSectors.map((sector, index) => {
          const isActive =
            currentProgress >= sector.startProgress && currentProgress < sector.endProgress;
          const isAhead = sector.sectorDeltaSec < 0;

          const bgClass = isAhead
            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
            : 'bg-rose-500/20 border-rose-500/50 text-rose-300';

          const activeRing = isActive ? 'ring-2 ring-cyan-400 font-bold' : '';

          const deltaStr =
            sector.sectorDeltaSec < 0
              ? `-${Math.abs(sector.sectorDeltaSec).toFixed(2)}s`
              : `+${Math.abs(sector.sectorDeltaSec).toFixed(2)}s`;

          const shortLabel = sector.label.includes(':')
            ? sector.label.split(':')[1].split('(')[0].trim()
            : sector.label.split('(')[0].trim();

          return (
            <button
              key={sector.sectorId}
              data-testid={`micro-sector-btn-${index}`}
              onClick={() => onSelectSector(sector.startProgress)}
              title={`${sector.label}: ${deltaStr} (${sector.dominantFactor})`}
              className={`flex flex-1 min-w-[70px] items-center justify-between rounded-lg border py-1.5 px-3 transition-all hover:brightness-125 ${bgClass} ${activeRing}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white">
                  S{index + 1}
                </span>
                <span className="text-[11px] font-semibold text-slate-300">
                  {shortLabel}
                </span>
              </div>
              <span className="font-mono text-xs font-bold tabular-nums">
                {deltaStr}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
