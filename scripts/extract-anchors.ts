import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  calibratePtsTimebase,
  predictForwardPriorGateWindows,
  type PriorGateWindow,
} from '../src/shared/kinematic-solver.js';
import type {
  AthleteRunTelemetry,
  CheckpointAnchor,
  CourseProfile,
  DataProvenance,
} from '../src/shared/types.js';
import {
  DOWNHILL_CLIP_TARGETS,
  MULTI_CAM_POS_ZONES,
  resolveDownhillComparisonSources,
} from './download-and-clip.js';
import { loadRealGpsTrack, type GpsTrack } from './downhill-gnss.js';

export type UnsolvedAthleteTelemetry = Omit<
  AthleteRunTelemetry,
  'samplesByProgress' | 'samplesByTime'
>;

export function buildRealGpsCourseProfileOverlay(
  baseCourse: CourseProfile,
  csvFilename = 'Ryan Cochran-Siegle-Beaver Creek_251203_DH-Tr.2-2025-12-03-Runs.csv'
): CourseProfile {
  const gps = loadRealGpsTrack(csvFilename);
  if (!gps) return baseCourse;

  const cosLat = Math.cos((39.574 * Math.PI) / 180);
  const startLat = gps.points[0].latitudeDeg;
  const startLon = gps.points[0].longitudeDeg;

  const eastMeters: number[] = [];
  const northMeters: number[] = [];
  for (const pt of gps.points) {
    eastMeters.push((pt.longitudeDeg - startLon) * 111320 * cosLat);
    northMeters.push((pt.latitudeDeg - startLat) * 110540);
  }

  const minE = Math.min(...eastMeters);
  const maxE = Math.max(...eastMeters);
  const minN = Math.min(...northMeters);
  const maxN = Math.max(...northMeters);
  const spanE = Math.max(1, maxE - minE);
  const spanN = Math.max(1, maxN - minN);

  const projectCoord = (s: number): { x: number; y: number; elevationMeters: number; pitchRatio: number } => {
    const clampedS = Math.max(0, Math.min(1, s));
    let idx = 0;
    while (idx < gps.points.length - 2 && gps.points[idx + 1].s < clampedS) {
      idx++;
    }
    const p0 = gps.points[idx];
    const p1 = gps.points[Math.min(gps.points.length - 1, idx + 1)];
    const spanS = Math.max(1e-9, p1.s - p0.s);
    const frac = Math.max(0, Math.min(1, (clampedS - p0.s) / spanS));

    const e = eastMeters[idx] + frac * (eastMeters[Math.min(eastMeters.length - 1, idx + 1)] - eastMeters[idx]);
    const n = northMeters[idx] + frac * (northMeters[Math.min(northMeters.length - 1, idx + 1)] - northMeters[idx]);
    const elev = p0.elevationMeters + frac * (p1.elevationMeters - p0.elevationMeters);

    // Map top of mountain (minN, maxE) to top-right/center of 2D canvas and finish (maxN, minE) to bottom-left
    const x = Number((120 + ((e - minE) / spanE) * 760).toFixed(2));
    const y = Number((70 + ((n - minN) / spanN) * 860).toFixed(2));

    const w0 = Math.max(0, idx - 3);
    const w1 = Math.min(gps.points.length - 1, idx + 3);
    const distDiff = Math.max(1, gps.points[w1].distanceMeters - gps.points[w0].distanceMeters);
    const dropDiff = Math.max(0, gps.points[w0].elevationMeters - gps.points[w1].elevationMeters);
    const pitchRatio = Number(Math.min(0.75, Math.max(0.05, dropDiff / distDiff)).toFixed(3));

    return {
      x,
      y,
      elevationMeters: Number(elev.toFixed(2)),
      pitchRatio,
    };
  };

  const trailSpline2D: CourseProfile['trailSpline2D'] = [];
  for (let i = 0; i <= 1000; i++) {
    const s = i / 1000;
    const pt = projectCoord(s);
    trailSpline2D.push({
      s,
      x: pt.x,
      y: pt.y,
      elevationMeters: pt.elevationMeters,
      pitchRatio: pt.pitchRatio,
    });
  }

  const updatedGates = baseCourse.gates.map((g) => {
    const pt = projectCoord(g.normalizedProgress);
    const cumDist = Number((g.normalizedProgress * gps.totalDistanceMeters).toFixed(2));
    return {
      ...g,
      cumulativeDistanceMeters: cumDist,
      mapX: pt.x,
      mapY: pt.y,
      elevationMeters: pt.elevationMeters,
      pitchRatio: pt.pitchRatio,
    };
  });

  return {
    ...baseCourse,
    title: 'Beaver Creek Downhill Training · December 3, 2025',
    sourceVideoFilename: 'RYACOC and BRYBEN Downhill Training POS1–POS8',
    totalDistanceMeters: gps.totalDistanceMeters,
    totalVerticalDropMeters: gps.totalVerticalDropMeters,
    gates: updatedGates,
    trailSpline2D,
  };
}

export function runFfmpegScdetOnClip(clipPath: string, scdetThreshold = 14): number[] {
  if (!fs.existsSync(clipPath)) return [];
  try {
    const stderr = execFileSync(
      'ffmpeg',
      ['-i', clipPath, '-vf', `scdet=threshold=${scdetThreshold}:sc_pass=1`, '-an', '-f', 'null', '-'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const cuts: number[] = [];
    const regex = /lavfi\.scd\.time:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(stderr)) !== null) {
      cuts.push(Number(Number(m[1]).toFixed(3)));
    }
    return detectShotCutsFromLumaDiff(
      cuts.map((timestampSec) => ({ timestampSec, lumaDiff: 1.0 })),
      0.42
    );
  } catch {
    return [];
  }
}

export function detectShotCutsFromLumaDiff(
  frameLumaHistogramDiffs: Array<{ timestampSec: number; lumaDiff: number }>,
  threshold = 0.42
): number[] {
  const cuts: number[] = [];
  let lastCutSec = -10;
  for (const sample of frameLumaHistogramDiffs) {
    if (sample.lumaDiff >= threshold && sample.timestampSec - lastCutSec >= 0.5) {
      cuts.push(Number(sample.timestampSec.toFixed(3)));
      lastCutSec = sample.timestampSec;
    }
  }
  return cuts;
}

export interface RawGateDetectionCandidate {
  gateNumber: number;
  rawVideoSec: number;
  confidenceSec: number;
  occluded?: boolean;
}

export function matchAnchorsToPriorWindows(
  windows: PriorGateWindow[],
  candidates: RawGateDetectionCandidate[],
  startWandVideoSec: number,
  finishBeamVideoSec: number,
  officialDurationSec: number
): CheckpointAnchor[] {
  const candidateByGate = new Map<number, RawGateDetectionCandidate>();
  for (const c of candidates) {
    candidateByGate.set(c.gateNumber, c);
  }

  return windows.map((w) => {
    const cand = candidateByGate.get(w.gateNumber);
    if (!cand || cand.occluded) {
      return {
        anchorId: `gate-${w.gateNumber}`,
        label: w.gateNumber === 38 ? 'Finish Beam (Gate 38)' : `Gate ${w.gateNumber}`,
        gateNumber: w.gateNumber,
        normalizedProgress: w.normalizedProgress,
        videoTimestampSec: w.expectedTimeSec,
        expectedWindowMinSec: w.windowMinSec,
        expectedWindowMaxSec: w.windowMaxSec,
        provenance: 'KINEMATIC_INTERPOLATED',
        confidenceSec: 0.08,
        ocrSpeedKmh: null,
      };
    }

    const calibratedSec = calibratePtsTimebase(
      cand.rawVideoSec,
      startWandVideoSec,
      finishBeamVideoSec,
      officialDurationSec
    );

    if (calibratedSec < w.windowMinSec || calibratedSec > w.windowMaxSec) {
      return {
        anchorId: `gate-${w.gateNumber}`,
        label: w.gateNumber === 38 ? 'Finish Beam (Gate 38)' : `Gate ${w.gateNumber}`,
        gateNumber: w.gateNumber,
        normalizedProgress: w.normalizedProgress,
        videoTimestampSec: w.expectedTimeSec,
        expectedWindowMinSec: w.windowMinSec,
        expectedWindowMaxSec: w.windowMaxSec,
        provenance: 'KINEMATIC_INTERPOLATED',
        confidenceSec: 0.08,
        ocrSpeedKmh: null,
      };
    }

    return {
      anchorId: `gate-${w.gateNumber}`,
      label: w.gateNumber === 38 ? 'Finish Beam (Gate 38)' : `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: Number(calibratedSec.toFixed(4)),
      expectedWindowMinSec: w.windowMinSec,
      expectedWindowMaxSec: w.windowMaxSec,
      provenance: 'GATE_CALIBRATED',
      confidenceSec: cand.confidenceSec,
      ocrSpeedKmh: null,
    };
  });
}

function buildSuperGBaselinePair(course: CourseProfile): {
  athleteA: UnsolvedAthleteTelemetry;
  athleteB: UnsolvedAthleteTelemetry;
} {
  const totalTimeA = 71.48;
  const totalTimeB = 71.92;
  const windowsA = predictForwardPriorGateWindows(course, totalTimeA);
  const windowsB = predictForwardPriorGateWindows(course, totalTimeB);

  const occludedGates = new Set<number>([12, 13, 27]);
  function tacticalOffsetB(gateNumber: number): number {
    if (gateNumber <= 6) {
      return -0.14 * (gateNumber / 6);
    }
    if (gateNumber <= 12) {
      return -0.14 + 0.22 * ((gateNumber - 6) / 6);
    }
    if (gateNumber <= 19) {
      return 0.08 + 0.19 * ((gateNumber - 12) / 7);
    }
    if (gateNumber <= 25) {
      return 0.27 - 0.05 * ((gateNumber - 19) / 6);
    }
    if (gateNumber <= 31) {
      return 0.22 + 0.18 * ((gateNumber - 25) / 6);
    }
    if (gateNumber < 38) {
      return 0.4 + 0.04 * ((gateNumber - 31) / 6);
    }
    return totalTimeB - totalTimeA;
  }

  const anchorsA: CheckpointAnchor[] = windowsA.map((w) => {
    const isOccluded = occludedGates.has(w.gateNumber);
    const prov: DataProvenance = isOccluded ? 'KINEMATIC_INTERPOLATED' : 'SIMULATED';
    return {
      anchorId: `gate-${w.gateNumber}`,
      label: w.gateNumber === 38 ? 'Finish Beam (Gate 38)' : `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: w.expectedTimeSec,
      expectedWindowMinSec: w.windowMinSec,
      expectedWindowMaxSec: w.windowMaxSec,
      provenance: prov,
      confidenceSec: isOccluded ? 0.08 : 0.03,
      ocrSpeedKmh: null,
    };
  });

  const anchorsB: CheckpointAnchor[] = windowsB.map((w, idx) => {
    const isOccluded = occludedGates.has(w.gateNumber);
    const prov: DataProvenance = isOccluded ? 'KINEMATIC_INTERPOLATED' : 'SIMULATED';
    const baseTimeA = windowsA[idx].expectedTimeSec;
    const rawTimeB =
      w.gateNumber === 38
        ? totalTimeB
        : Number((baseTimeA + tacticalOffsetB(w.gateNumber)).toFixed(4));
    return {
      anchorId: `gate-${w.gateNumber}`,
      label: w.gateNumber === 38 ? 'Finish Beam (Gate 38)' : `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: rawTimeB,
      expectedWindowMinSec: Math.min(w.windowMinSec, rawTimeB - 0.5),
      expectedWindowMaxSec: Math.max(w.windowMaxSec, rawTimeB + 0.5),
      provenance: prov,
      confidenceSec: isOccluded ? 0.08 : 0.03,
      ocrSpeedKmh: null,
    };
  });

  return {
    athleteA: {
      athleteId: 'odermatt-sg',
      athleteName: 'Marco Odermatt',
      bibNumber: 7,
      countryCode: 'SUI',
      clipUrl: '/api/clips/sg-athlete-a.mp4',
      startClipOffsetSec: 1.5,
      totalTimeSec: totalTimeA,
      nativeFps: 29.97002997,
      anchors: anchorsA,
    },
    athleteB: {
      athleteId: 'cochran-siegle-sg',
      athleteName: 'Ryan Cochran-Siegle',
      bibNumber: 11,
      countryCode: 'USA',
      clipUrl: '/api/clips/sg-athlete-b.mp4',
      startClipOffsetSec: 1.5,
      totalTimeSec: totalTimeB,
      nativeFps: 29.97002997,
      anchors: anchorsB,
    },
  };
}

function buildDownhillBaselinePair(
  gpsPair: { athleteA: GpsTrack; athleteB: GpsTrack } | null
): {
  athleteA: UnsolvedAthleteTelemetry;
  athleteB: UnsolvedAthleteTelemetry;
} {
  if (gpsPair) {
    const { athleteA: gpsA, athleteB: gpsB } = gpsPair;
    const totalTimeA = gpsA.totalTimeSec;
    const totalTimeB = gpsB.totalTimeSec;
    const realCheckpointSpecs = [
      { anchorId: 'dh-pos1-flat', label: 'POS1 — Upper Flat Glide', s: 0.07 },
      { anchorId: 'dh-pos2-handoff', label: 'POS2 Handoff — Upper Flat Crest', s: 0.14 },
      { anchorId: 'dh-split-1', label: 'Checkpoint 1 — Flyaway & Brink Entry (POS2)', s: 0.18 },
      { anchorId: 'dh-pos3-handoff', label: 'POS3 Handoff — The Brink Rollover', s: 0.22 },
      { anchorId: 'dh-pos3-talon', label: 'POS3 — Upper Talon Steep Turns', s: 0.28 },
      { anchorId: 'dh-pos4-handoff', label: 'POS4 Handoff — Talon Mid-Pitch', s: 0.33 },
      { anchorId: 'dh-split-2', label: 'Checkpoint 2 — Talon Steep Exit (POS4)', s: 0.41 },
      { anchorId: 'dh-pos4-screech-owl', label: 'POS4 — Screech Owl Jump Landing', s: 0.46 },
      { anchorId: 'dh-pos5-handoff', label: 'POS5 Handoff — Peregrine Entry', s: 0.505 },
      { anchorId: 'dh-pos5-celsius', label: 'POS5 — Peregrine High-Speed Carve', s: 0.57 },
      { anchorId: 'dh-split-3', label: 'Checkpoint 3 — Golden Eagle Approach (POS5)', s: 0.63 },
      { anchorId: 'dh-pos6-handoff', label: 'POS6 Handoff — Golden Eagle Compression', s: 0.665 },
      { anchorId: 'dh-pos6-abyss', label: 'POS6 — Abyss S-Turn Transition', s: 0.74 },
      { anchorId: 'dh-pos7-handoff', label: 'POS7 Handoff — Harrier Entry', s: 0.8 },
      { anchorId: 'dh-split-4', label: 'Checkpoint 4 — Harrier Technical Exit (POS7)', s: 0.84 },
      { anchorId: 'dh-pos8-handoff', label: 'POS8 Handoff — STIFEL Overhead Arch', s: 0.92 },
      { anchorId: 'dh-finish', label: 'Course finish (100%)', s: 1.0 },
    ];

    function buildGnssAnchors(track: GpsTrack): CheckpointAnchor[] {
      return realCheckpointSpecs.map((checkpoint) => {
        const sample = track.sampleAtProgress(checkpoint.s);
        return {
          anchorId: checkpoint.anchorId,
          label: checkpoint.label,
          gateNumber: null,
          normalizedProgress: checkpoint.s,
          videoTimestampSec: sample.elapsedTimeSec,
          expectedWindowMinSec: Math.max(0, sample.elapsedTimeSec - 1.2),
          expectedWindowMaxSec: Math.min(track.totalTimeSec, sample.elapsedTimeSec + 1.2),
          provenance: 'GNSS_DERIVED',
          confidenceSec: 0.1,
          ocrSpeedKmh: null,
          gnssSpeedKmh: sample.speedKmh,
        };
      });
    }

    const anchorsA = buildGnssAnchors(gpsA);
    const anchorsB = buildGnssAnchors(gpsB);

    return {
      athleteA: {
        athleteId: 'cochran-siegle-dh',
        athleteName: 'Ryan Cochran-Siegle',
        bibNumber: 11,
        countryCode: 'USA',
        clipUrl: '/api/clips/dh-athlete-a.mp4',
        startClipOffsetSec: 1.5,
        totalTimeSec: totalTimeA,
        nativeFps: 29.97002997,
        anchors: anchorsA,
      },
      athleteB: {
        athleteId: 'bennett-dh',
        athleteName: 'Bryce Bennett',
        bibNumber: 14,
        countryCode: 'USA',
        clipUrl: '/api/clips/dh-athlete-b.mp4',
        startClipOffsetSec: 1.5,
        totalTimeSec: totalTimeB,
        nativeFps: 29.97002997,
        anchors: anchorsB,
      },
    };
  }

  const totalTimeA = DOWNHILL_CLIP_TARGETS[0].simulatedRunDurationSec;
  const totalTimeB = DOWNHILL_CLIP_TARGETS[1].simulatedRunDurationSec;

  const dhCheckpoints: Array<{
    anchorId: string;
    label: string;
    s: number;
    tA: number;
    tB: number;
    confidenceSec: number;
  }> = [
    {
      anchorId: 'dh-landmark-start-crest',
      label: 'Upper Flat Crest Arch',
      s: 0.09,
      tA: 10.12,
      tB: 9.96,
      confidenceSec: 0.04,
    },
    {
      anchorId: 'dh-split-1',
      label: 'Split 1 — Flyaway Jump',
      s: 0.18,
      tA: 18.42,
      tB: 18.19,
      confidenceSec: 0.01,
    },
    {
      anchorId: 'dh-landmark-brink-entry',
      label: 'The Brink Rollover Gate',
      s: 0.29,
      tA: 29.45,
      tB: 29.52,
      confidenceSec: 0.04,
    },
    {
      anchorId: 'dh-split-2',
      label: 'Split 2 — Talon Steep Exit',
      s: 0.41,
      tA: 41.36,
      tB: 41.68,
      confidenceSec: 0.01,
    },
    {
      anchorId: 'dh-landmark-screech-owl',
      label: 'Screech Owl Jump Lip (Occluded Spray)',
      s: 0.52,
      tA: 52.18,
      tB: 52.64,
      confidenceSec: 0.09,
    },
    {
      anchorId: 'dh-split-3',
      label: 'Split 3 — Golden Eagle Jump Speed Trap',
      s: 0.63,
      tA: 62.74,
      tB: 63.29,
      confidenceSec: 0.01,
    },
    {
      anchorId: 'dh-landmark-abyss',
      label: 'Abyss Compression Gate',
      s: 0.74,
      tA: 73.68,
      tB: 74.28,
      confidenceSec: 0.04,
    },
    {
      anchorId: 'dh-split-4',
      label: 'Split 4 — Red Tail Approach',
      s: 0.84,
      tA: 83.62,
      tB: 84.24,
      confidenceSec: 0.01,
    },
    {
      anchorId: 'dh-finish',
      label: 'Finish Photo-Beam',
      s: 1.0,
      tA: totalTimeA,
      tB: totalTimeB,
      confidenceSec: 0.01,
    },
  ];

  const anchorsA: CheckpointAnchor[] = dhCheckpoints.map((cp) => ({
    anchorId: cp.anchorId,
    label: cp.label,
    gateNumber: null,
    normalizedProgress: cp.s,
    videoTimestampSec: cp.tA,
    expectedWindowMinSec: Math.max(0, Number((cp.tA - 1.2).toFixed(2))),
    expectedWindowMaxSec: Math.min(totalTimeA, Number((cp.tA + 1.2).toFixed(2))),
    provenance: 'SIMULATED',
    confidenceSec: cp.confidenceSec,
    ocrSpeedKmh: null,
  }));

  const anchorsB: CheckpointAnchor[] = dhCheckpoints.map((cp) => ({
    anchorId: cp.anchorId,
    label: cp.label,
    gateNumber: null,
    normalizedProgress: cp.s,
    videoTimestampSec: cp.tB,
    expectedWindowMinSec: Math.max(0, Number((cp.tB - 1.2).toFixed(2))),
    expectedWindowMaxSec: Math.min(totalTimeB, Number((cp.tB + 1.2).toFixed(2))),
    provenance: 'SIMULATED',
    confidenceSec: cp.confidenceSec,
    ocrSpeedKmh: null,
  }));

  return {
    athleteA: {
      athleteId: 'odermatt-dh',
      athleteName: 'Marco Odermatt',
      bibNumber: 8,
      countryCode: 'SUI',
      clipUrl: '/api/clips/dh-athlete-a.mp4',
      startClipOffsetSec: 1.5,
      totalTimeSec: totalTimeA,
      nativeFps: 29.97002997,
      anchors: anchorsA,
    },
    athleteB: {
      athleteId: 'bennett-dh',
      athleteName: 'Bryce Bennett',
      bibNumber: 14,
      countryCode: 'USA',
      clipUrl: '/api/clips/dh-athlete-b.mp4',
      startClipOffsetSec: 1.5,
      totalTimeSec: totalTimeB,
      nativeFps: 29.97002997,
      anchors: anchorsB,
    },
  };
}

export function extractOrLoadBaselineAnchors(
  raceId: string,
  course: CourseProfile
): {
  isSyntheticDemo: boolean;
  provenanceDisclosure: string;
  athleteA: UnsolvedAthleteTelemetry;
  athleteB: UnsolvedAthleteTelemetry;
} {
  if (raceId === 'beaver-creek-men-sg-2025') {
    return {
      isSyntheticDemo: true,
      provenanceDisclosure: 'Synthetic / Simulated Demo Data. Super-G course geometry is paired with simulated video and run telemetry.',
      ...buildSuperGBaselinePair(course),
    };
  }

  if (raceId === 'beaver-creek-men-dh-2025') {
    const sources = resolveDownhillComparisonSources();
    const gpsA = sources.get(DOWNHILL_CLIP_TARGETS[0].clipKey)?.track;
    const gpsB = sources.get(DOWNHILL_CLIP_TARGETS[1].clipKey)?.track;
    const gpsPair = gpsA && gpsB ? { athleteA: gpsA, athleteB: gpsB } : null;
    return {
      isSyntheticDemo: gpsPair === null,
      provenanceDisclosure: gpsPair
        ? `Legacy wearable GNSS comparison with ${MULTI_CAM_POS_ZONES.length} stitched Downhill camera positions. Checkpoint times and speed are derived from 10 Hz GNSS. Video alignment is approximate.`
        : 'Synthetic / Simulated Demo Data. The Downhill comparison requires eight camera positions and a GNSS file for each athlete.',
      ...buildDownhillBaselinePair(gpsPair),
    };
  }
  throw new Error(`Unsupported raceId: ${raceId}`);
}
