import type {
  AthleteRunTelemetry,
  CoachingHighlight,
  CourseGatePoint,
  CourseProfile,
  DataProvenance,
  MicroSectorComparison,
  SpatialSample,
} from './types.js';

interface SectorDefinition {
  sectorId: string;
  label: string;
  startProgress: number;
  endProgress: number;
  startGate: number | null;
  endGate: number | null;
  gatesInSector: CourseGatePoint[];
}

function clampIndex(s: number): number {
  return Math.max(0, Math.min(1000, Math.round(s * 1000)));
}

function sampleAtProgress(
  samples: SpatialSample[],
  s: number
): SpatialSample {
  return samples[clampIndex(s)];
}

function provenanceRank(p: DataProvenance): number {
  switch (p) {
    case 'SIMULATED':
      return -1;
    case 'KINEMATIC_INTERPOLATED':
      return 0;
    case 'MANUALLY_ANNOTATED':
      return 1;
    case 'GATE_CALIBRATED':
      return 2;
    case 'GNSS_DERIVED':
      return 2;
    case 'OCR_MEASURED':
      return 3;
  }
}

function buildSectorDefinitions(course: CourseProfile): SectorDefinition[] {
  const useModeA = course.hasGpsCourseMap && course.courseMapEnabled && course.gates.length >= 38;

  if (useModeA) {
    const groups: Array<{ id: string; label: string; startGate: number; endGate: number }> = [
      { id: 'sg-sec-1', label: 'Sector 1: Upper Pitch (Gates 1–6)', startGate: 1, endGate: 6 },
      { id: 'sg-sec-2', label: 'Sector 2: Brink Steep (Gates 7–12)', startGate: 7, endGate: 12 },
      { id: 'sg-sec-3', label: 'Sector 3: Talon Delayed (Gates 13–19)', startGate: 13, endGate: 19 },
      { id: 'sg-sec-4', label: 'Sector 4: Mid-Mountain Rhythm (Gates 20–25)', startGate: 20, endGate: 25 },
      { id: 'sg-sec-5', label: 'Sector 5: Golden Eagle Flats (Gates 26–31)', startGate: 26, endGate: 31 },
      { id: 'sg-sec-6', label: 'Sector 6: Red Tail Finish (Gates 32–38)', startGate: 32, endGate: 38 },
    ];

    let prevEndProgress = 0;
    return groups.map((g) => {
      const gatesInSector = course.gates.filter(
        (gate) => gate.gateNumber >= g.startGate && gate.gateNumber <= g.endGate
      );
      const endProgress =
        gatesInSector.length > 0
          ? gatesInSector[gatesInSector.length - 1].normalizedProgress
          : 1;
      const def: SectorDefinition = {
        sectorId: g.id,
        label: g.label,
        startProgress: prevEndProgress,
        endProgress,
        startGate: g.startGate,
        endGate: g.endGate,
        gatesInSector,
      };
      prevEndProgress = endProgress;
      return def;
    });
  }

  // Mode B: 5 landmark/split sectors on [0, 1]
  const modeBStops = [
    { id: 'sec-1', label: 'Sector 1: Start to Flyaway Split 1', sEnd: 0.18 },
    { id: 'sec-2', label: 'Sector 2: Brink & Talon Steep Split 2', sEnd: 0.41 },
    { id: 'sec-3', label: 'Sector 3: Golden Eagle Jump Split 3', sEnd: 0.63 },
    { id: 'sec-4', label: 'Sector 4: Abyss Compression Split 4', sEnd: 0.84 },
    { id: 'sec-5', label: 'Sector 5: Red Tail Finish Approach', sEnd: 1.0 },
  ];

  let prevS = 0;
  return modeBStops.map((stop, idx) => {
    const gateMatch = course.gates[idx];
    const def: SectorDefinition = {
      sectorId: stop.id,
      label: stop.label,
      startProgress: prevS,
      endProgress: stop.sEnd,
      startGate: null,
      endGate: null,
      gatesInSector: gateMatch ? [gateMatch] : [],
    };
    prevS = stop.sEnd;
    return def;
  });
}

/**
 * Computes micro-sector deltas and decomposes time swings exhaustively into
 * Turn Execution Delta vs. Glide Carry Delta for both Mode A and Mode B.
 */
export function computeMicroSectorsAndHighlights(
  course: CourseProfile,
  athleteA: AthleteRunTelemetry,
  athleteB: AthleteRunTelemetry
): {
  microSectors: MicroSectorComparison[];
  coachingHighlights: CoachingHighlight[];
} {
  const sectorDefs = buildSectorDefinitions(course);
  const useModeA = course.hasGpsCourseMap && course.courseMapEnabled && course.gates.length >= 38;

  const microSectors: MicroSectorComparison[] = [];
  const coachingHighlights: CoachingHighlight[] = [];

  for (const def of sectorDefs) {
    const startSampleA = sampleAtProgress(athleteA.samplesByProgress, def.startProgress);
    const endSampleA = sampleAtProgress(athleteA.samplesByProgress, def.endProgress);
    const startSampleB = sampleAtProgress(athleteB.samplesByProgress, def.startProgress);
    const endSampleB = sampleAtProgress(athleteB.samplesByProgress, def.endProgress);

    const athleteASectorTimeSec = Number(
      (endSampleA.elapsedTimeSec - startSampleA.elapsedTimeSec).toFixed(4)
    );
    const athleteBSectorTimeSec = Number(
      (endSampleB.elapsedTimeSec - startSampleB.elapsedTimeSec).toFixed(4)
    );
    const sectorDeltaSec = Number(
      (athleteASectorTimeSec - athleteBSectorTimeSec).toFixed(4)
    );
    const cumulativeDeltaEndSec = Number(
      (endSampleA.elapsedTimeSec - endSampleB.elapsedTimeSec).toFixed(4)
    );

    let turnExecutionDeltaSec = 0;
    let glideCarryDeltaSec = 0;

    if (useModeA && def.gatesInSector.length > 0) {
      let rawTurnSum = 0;
      let subPrevS = def.startProgress;

      for (const gate of def.gatesInSector) {
        const subEndS = gate.normalizedProgress;
        const tA0 = sampleAtProgress(athleteA.samplesByProgress, subPrevS).elapsedTimeSec;
        const tA1 = sampleAtProgress(athleteA.samplesByProgress, subEndS).elapsedTimeSec;
        const tB0 = sampleAtProgress(athleteB.samplesByProgress, subPrevS).elapsedTimeSec;
        const tB1 = sampleAtProgress(athleteB.samplesByProgress, subEndS).elapsedTimeSec;

        const subDelta = tA1 - tA0 - (tB1 - tB0);
        const isTurnSegment = Math.abs(gate.angleDeg) >= 15 || gate.type === 'Delayed';
        if (isTurnSegment) {
          rawTurnSum += subDelta;
        }
        subPrevS = subEndS;
      }

      turnExecutionDeltaSec = Number(rawTurnSum.toFixed(4));
      glideCarryDeltaSec = Number((sectorDeltaSec - turnExecutionDeltaSec).toFixed(4));
    } else {
      // Mode B: Decompose sector delta into velocity carry vs. technical turn execution
      const startIdx = clampIndex(def.startProgress);
      const endIdx = clampIndex(def.endProgress);
      let rawGlideSum = 0;

      for (let i = startIdx; i < endIdx; i++) {
        const curA = athleteA.samplesByProgress[i];
        const nextA = athleteA.samplesByProgress[i + 1];
        const curB = athleteB.samplesByProgress[i];
        const nextB = athleteB.samplesByProgress[i + 1];

        const tickDelta =
          nextA.elapsedTimeSec -
          curA.elapsedTimeSec -
          (nextB.elapsedTimeSec - curB.elapsedTimeSec);

        // Classify ticks with low pitch (< 0.28) or accelerating glide (dv >= 0) as glide carry
        const isGlideTick =
          nextA.pitchRatio < 0.28 || nextA.speedKmh >= curA.speedKmh;
        if (isGlideTick) {
          rawGlideSum += tickDelta;
        }
      }

      glideCarryDeltaSec = Number(rawGlideSum.toFixed(4));
      turnExecutionDeltaSec = Number((sectorDeltaSec - glideCarryDeltaSec).toFixed(4));
    }

    const absTurn = Math.abs(turnExecutionDeltaSec);
    const absGlide = Math.abs(glideCarryDeltaSec);
    let dominantFactor: 'TURN_EXECUTION' | 'GLIDE_CARRY' | 'BALANCED' = 'BALANCED';
    if (absTurn >= 1.25 * absGlide) {
      dominantFactor = 'TURN_EXECUTION';
    } else if (absGlide >= 1.25 * absTurn) {
      dominantFactor = 'GLIDE_CARRY';
    }

    microSectors.push({
      sectorId: def.sectorId,
      label: def.label,
      startProgress: def.startProgress,
      endProgress: def.endProgress,
      startGate: def.startGate,
      endGate: def.endGate,
      athleteASectorTimeSec,
      athleteBSectorTimeSec,
      sectorDeltaSec,
      cumulativeDeltaEndSec,
      turnExecutionDeltaSec,
      glideCarryDeltaSec,
      dominantFactor,
    });

    if (Math.abs(sectorDeltaSec) >= 0.12) {
      const entrySpeedDiffKmh = Number(
        (startSampleA.speedKmh - startSampleB.speedKmh).toFixed(2)
      );
      const exitSpeedDiffKmh = Number(
        (endSampleA.speedKmh - endSampleB.speedKmh).toFixed(2)
      );

      const fasterAthlete =
        sectorDeltaSec < 0 ? athleteA.athleteName : athleteB.athleteName;
      const slowerAthlete =
        sectorDeltaSec < 0 ? athleteB.athleteName : athleteA.athleteName;
      const absSwing = Math.abs(sectorDeltaSec).toFixed(2);
      const absTurnStr = Math.abs(turnExecutionDeltaSec).toFixed(2);
      const absGlideStr = Math.abs(glideCarryDeltaSec).toFixed(2);
      const absExitDiff = Math.abs(exitSpeedDiffKmh).toFixed(1);

      let mechanismClause: string;
      if (dominantFactor === 'TURN_EXECUTION') {
        mechanismClause = `primarily through cleaner high-angle turn execution (${absTurnStr}s turn delta vs. ${absGlideStr}s glide delta)`;
      } else if (dominantFactor === 'GLIDE_CARRY') {
        mechanismClause = `primarily by carrying +${absExitDiff} km/h higher exit speed onto the glide section (${absGlideStr}s glide delta vs. ${absTurnStr}s turn delta)`;
      } else {
        mechanismClause = `combining ${absTurnStr}s in turn execution with ${absGlideStr}s in glide speed carry (exit speed differential ${absExitDiff} km/h)`;
      }

      const prov =
        provenanceRank(endSampleA.provenance) <= provenanceRank(endSampleB.provenance)
          ? endSampleA.provenance
          : endSampleB.provenance;
      const speedUnc = Math.max(
        endSampleA.speedUncertaintyKmh,
        endSampleB.speedUncertaintyKmh
      );

      coachingHighlights.push({
        id: `highlight-${def.sectorId}`,
        title: `${fasterAthlete} gained ${absSwing}s in ${def.label}`,
        sectionLabel: def.label,
        startProgress: def.startProgress,
        endProgress: def.endProgress,
        athleteATimestampSec: startSampleA.elapsedTimeSec,
        athleteBTimestampSec: startSampleB.elapsedTimeSec,
        timeSwingSec: sectorDeltaSec,
        turnExecutionDeltaSec,
        glideCarryDeltaSec,
        entrySpeedDiffKmh,
        exitSpeedDiffKmh,
        summaryText: `${fasterAthlete} gained ${absSwing}s over ${slowerAthlete} across ${def.label}, ${mechanismClause}.`,
        uncertaintyNote: `Provenance: ${prov} (speed uncertainty ±${speedUnc.toFixed(1)} km/h, timing confidence ±0.03s).`,
        provenance: prov,
      });
    }
  }

  coachingHighlights.sort(
    (a, b) => Math.abs(b.timeSwingSec) - Math.abs(a.timeSwingSec)
  );

  return { microSectors, coachingHighlights };
}
