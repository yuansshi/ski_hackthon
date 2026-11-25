import { computeMicroSectorsAndHighlights } from './coaching-attribution.js';
import type {
  AnchorOverrideRecord,
  AthleteRunTelemetry,
  CheckpointAnchor,
  CourseProfile,
  DataProvenance,
  RaceComparisonManifest,
  SpatialSample,
  TemporalSample,
} from './types.js';

const GRAVITY_MPS2 = 9.81;
const INITIAL_START_SPEED_MPS = 4.0;
const SNOW_FRICTION_MU = 0.035;
const AERO_DRAG_PER_M = 0.0016;
const TURN_LOSS_PER_DEG = 0.0032;
const MIN_SPEED_MPS = 6.0;
const MAX_SPEED_MPS = 38.0;
const KMH_TO_MPH = 0.6213711922;

function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function round4(val: number): number {
  return Math.round(val * 10000) / 10000;
}

/**
 * Calibrates raw broadcast video timestamps (29.97 / 59.94 fps NTSC) to official FIS duration
 * anchored at the start-wand trigger (t = 0) and finish photo-beam crossing (t = officialDurationSec).
 */
export function calibratePtsTimebase(
  rawVideoSec: number,
  startWandVideoSec: number,
  finishBeamVideoSec: number,
  officialDurationSec: number
): number {
  const rawSpan = finishBeamVideoSec - startWandVideoSec;
  if (rawSpan <= 0 || officialDurationSec <= 0) {
    throw new Error('finishBeamVideoSec must be greater than startWandVideoSec and officialDurationSec > 0');
  }
  const calibrated = ((rawVideoSec - startWandVideoSec) * officialDurationSec) / rawSpan;
  return Math.round(calibrated * 1000000) / 1000000;
}

export interface PriorGateWindow {
  gateNumber: number;
  normalizedProgress: number;
  expectedTimeSec: number;
  windowMinSec: number;
  windowMaxSec: number;
}

/**
 * Integrates the discrete forward energy model down the course gates to predict
 * gate passage timestamps and +-1.2s search windows.
 */
export function predictForwardPriorGateWindows(
  course: CourseProfile,
  totalTimeSec: number
): PriorGateWindow[] {
  if (totalTimeSec <= 0) {
    throw new Error('totalTimeSec must be positive');
  }

  const gates = course.gates;
  if (gates.length === 0) {
    return [];
  }

  let vPrev = INITIAL_START_SPEED_MPS;
  const rawGateTimes: number[] = new Array(gates.length);
  let accumTime = 0;

  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i];
    const d = Math.max(0.5, gate.segmentDistanceMeters);
    const sinAlpha = clamp(gate.verticalDropMeters / d, -0.8, 0.85);
    const cosAlpha = Math.sqrt(Math.max(0.01, 1 - sinAlpha * sinAlpha));
    const absAngle = Math.abs(gate.angleDeg);

    const accelTerm =
      GRAVITY_MPS2 * sinAlpha -
      SNOW_FRICTION_MU * GRAVITY_MPS2 * cosAlpha -
      AERO_DRAG_PER_M * vPrev * vPrev -
      (TURN_LOSS_PER_DEG * absAngle * vPrev * vPrev) / d;

    const vNextSq = vPrev * vPrev + 2 * d * accelTerm;
    const vNext = clamp(
      Math.sqrt(Math.max(MIN_SPEED_MPS * MIN_SPEED_MPS, vNextSq)),
      MIN_SPEED_MPS,
      MAX_SPEED_MPS
    );
    const vMean = 0.5 * (vPrev + vNext);
    accumTime += d / vMean;
    rawGateTimes[i] = accumTime;
    vPrev = vNext;
  }

  const uncalibratedTotal = Math.max(1e-6, rawGateTimes[rawGateTimes.length - 1]);
  const scale = totalTimeSec / uncalibratedTotal;

  const windows: PriorGateWindow[] = new Array(gates.length);
  let prevExpected = 0;

  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i];
    const expectedTimeSec = round4(rawGateTimes[i] * scale);
    const minKinematicStep = gate.segmentDistanceMeters / MAX_SPEED_MPS;
    const windowMinSec = round4(
      Math.max(prevExpected + minKinematicStep, expectedTimeSec - 1.2)
    );
    const windowMaxSec = round4(Math.min(totalTimeSec, expectedTimeSec + 1.2));

    windows[i] = {
      gateNumber: gate.gateNumber,
      normalizedProgress: gate.normalizedProgress,
      expectedTimeSec,
      windowMinSec: Math.min(windowMinSec, expectedTimeSec),
      windowMaxSec: Math.max(windowMaxSec, expectedTimeSec),
    };

    prevExpected = expectedTimeSec;
  }

  return windows;
}

interface KnotPoint {
  s: number;
  t: number;
  provenance: DataProvenance;
  speedAtAnchorKmh: number | null;
  gateNumber: number | null;
}

/**
 * Fits a derivative-constrained Fritsch-Carlson monotonic cubic Hermite spline (PCHIP)
 * for elapsed time t(s) over s in [0, 1].
 */
function buildDerivativeConstrainedPchip(
  knots: KnotPoint[],
  totalDistanceMeters: number
): {
  h: number[];
  d: number[];
  minSlope: number;
  maxSlope: number;
} {
  const n = knots.length;
  const h: number[] = new Array(n - 1);
  const delta: number[] = new Array(n - 1);

  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(1e-6, knots[i + 1].s - knots[i].s);
    delta[i] = Math.max(1e-4, (knots[i + 1].t - knots[i].t) / h[i]);
  }

  const d: number[] = new Array(n);
  d[0] = delta[0];
  d[n - 1] = delta[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  const minSlope = totalDistanceMeters / MAX_SPEED_MPS;
  const maxSlope = totalDistanceMeters / MIN_SPEED_MPS;

  for (let i = 0; i < n; i++) {
    const leftDelta = i > 0 ? delta[i - 1] : delta[0];
    const rightDelta = i < n - 1 ? delta[i] : delta[n - 2];
    const fcMax = 3 * Math.min(leftDelta, rightDelta);
    const fcMin = Math.max(minSlope, 0.35 * Math.min(leftDelta, rightDelta));

    const speedAtAnchor = knots[i].speedAtAnchorKmh;
    if (speedAtAnchor !== null && speedAtAnchor > 5) {
      const speedMps = speedAtAnchor / 3.6;
      const trapSlope = totalDistanceMeters / speedMps;
      d[i] = clamp(trapSlope, fcMin, Math.max(fcMin, Math.min(maxSlope, fcMax)));
    } else {
      d[i] = clamp(d[i], fcMin, Math.max(fcMin, Math.min(maxSlope, fcMax)));
    }
  }

  return { h, d, minSlope, maxSlope };
}

function uncertaintyForProvenance(
  provenance: DataProvenance,
  courseMapEnabled: boolean
): number {
  switch (provenance) {
    case 'OCR_MEASURED':
      return 0.5;
    case 'MANUALLY_ANNOTATED':
      return 1.0;
    case 'GATE_CALIBRATED':
      return courseMapEnabled ? 1.5 : 2.5;
    case 'GNSS_DERIVED':
      return 4.0;
    case 'SIMULATED':
    case 'KINEMATIC_INTERPOLATED':
      return courseMapEnabled ? 3.5 : 4.0;
  }
}

/**
 * Solves for dual-indexed athlete telemetry (samplesByProgress and samplesByTime)
 * in either Mode A (GPS Gate-Calibrated) or Mode B (Video-Only Baseline).
 */
export function solveAthleteTrajectory(
  course: CourseProfile,
  athleteMeta: Omit<AthleteRunTelemetry, 'samplesByProgress' | 'samplesByTime'>,
  courseMapEnabled: boolean
): AthleteRunTelemetry {
  const useModeA = course.hasGpsCourseMap && courseMapEnabled;
  const totalDistanceMeters = course.totalDistanceMeters;
  const totalTimeSec = athleteMeta.totalTimeSec;
  const priorWindows = predictForwardPriorGateWindows(course, totalTimeSec);

  const sourceAnchors: CheckpointAnchor[] = [];
  for (let i = 0; i < athleteMeta.anchors.length; i++) {
    const a = athleteMeta.anchors[i];
    if (
      useModeA ||
      a.normalizedProgress === 0 ||
      a.normalizedProgress === 1 ||
      a.provenance === 'OCR_MEASURED' ||
      a.provenance === 'MANUALLY_ANNOTATED' ||
      a.gateNumber === null ||
      a.gateNumber % 6 === 0 ||
      a.gateNumber === 38
    ) {
      sourceAnchors.push(a);
    }
  }
  sourceAnchors.sort((a, b) => a.normalizedProgress - b.normalizedProgress);

  const startAnchor = sourceAnchors.find((anchor) => anchor.normalizedProgress === 0);
  const knots: KnotPoint[] = [
    {
      s: 0,
      t: 0,
      provenance: startAnchor?.provenance ?? 'KINEMATIC_INTERPOLATED',
      speedAtAnchorKmh: startAnchor?.gnssSpeedKmh ?? startAnchor?.ocrSpeedKmh ?? null,
      gateNumber: 0,
    },
  ];

  if (useModeA) {
    const anchorByGate = new Map<number, CheckpointAnchor>();
    for (let i = 0; i < sourceAnchors.length; i++) {
      const a = sourceAnchors[i];
      if (a.gateNumber !== null) {
        anchorByGate.set(a.gateNumber, a);
      }
    }

    const observedPoints: Array<{
      idx: number;
      s: number;
      t: number;
      provenance: DataProvenance;
    }> = [
      {
        idx: -1,
        s: 0,
        t: 0,
        provenance: knots[0].provenance,
      },
    ];

    for (let i = 0; i < course.gates.length; i++) {
      const gate = course.gates[i];
      const existing = anchorByGate.get(gate.gateNumber);
      if (existing && existing.provenance !== 'KINEMATIC_INTERPOLATED') {
        observedPoints.push({
          idx: i,
          s: gate.normalizedProgress,
          t: existing.videoTimestampSec,
          provenance: existing.provenance,
        });
      }
    }

    const lastObs = observedPoints[observedPoints.length - 1];
    if (lastObs.idx !== course.gates.length - 1) {
      observedPoints.push({
        idx: course.gates.length - 1,
        s: 1,
        t: totalTimeSec,
        provenance: 'KINEMATIC_INTERPOLATED',
      });
    }

    for (let seg = 0; seg < observedPoints.length - 1; seg++) {
      const left = observedPoints[seg];
      const right = observedPoints[seg + 1];
      const priorLeftT = left.idx >= 0 ? priorWindows[left.idx].expectedTimeSec : 0;
      const priorRightT = priorWindows[right.idx].expectedTimeSec;
      const priorSpan = Math.max(1e-6, priorRightT - priorLeftT);

      for (let gIdx = left.idx + 1; gIdx <= right.idx; gIdx++) {
        const gate = course.gates[gIdx];
        const priorT = priorWindows[gIdx].expectedTimeSec;
        const frac = clamp((priorT - priorLeftT) / priorSpan, 0, 1);
        const isObserved = gIdx === right.idx;
        const tVal = isObserved ? right.t : round4(left.t + frac * (right.t - left.t));
        const existingAnchor = anchorByGate.get(gate.gateNumber);
        const prov: DataProvenance = isObserved
          ? right.provenance
          : 'KINEMATIC_INTERPOLATED';

        knots.push({
          s: gate.normalizedProgress,
          t: tVal,
          provenance: prov,
          speedAtAnchorKmh: existingAnchor?.gnssSpeedKmh ?? existingAnchor?.ocrSpeedKmh ?? null,
          gateNumber: gate.gateNumber,
        });
      }
    }
  } else {
    for (let i = 0; i < sourceAnchors.length; i++) {
      const a = sourceAnchors[i];
      if (a.normalizedProgress <= 0) continue;
      const prevKnot = knots[knots.length - 1];
      if (a.normalizedProgress <= prevKnot.s) continue;
      const safeT = Math.max(prevKnot.t + 0.02, a.videoTimestampSec);
      const effectiveProv: DataProvenance =
        !courseMapEnabled && a.provenance === 'GATE_CALIBRATED'
          ? 'KINEMATIC_INTERPOLATED'
          : a.provenance;
      knots.push({
        s: a.normalizedProgress,
        t: safeT,
        provenance: effectiveProv,
        speedAtAnchorKmh: a.gnssSpeedKmh ?? a.ocrSpeedKmh,
        gateNumber: courseMapEnabled ? a.gateNumber : null,
      });
    }

    if (knots[knots.length - 1].s < 1) {
      knots.push({
        s: 1,
        t: totalTimeSec,
        provenance: 'KINEMATIC_INTERPOLATED',
        speedAtAnchorKmh: null,
        gateNumber: null,
      });
    } else {
      knots[knots.length - 1].t = totalTimeSec;
    }
  }

  for (let i = 1; i < knots.length; i++) {
    if (knots[i].t <= knots[i - 1].t) {
      knots[i].t = round4(knots[i - 1].t + 0.02);
    }
  }

  const { h, d, minSlope, maxSlope } = buildDerivativeConstrainedPchip(
    knots,
    totalDistanceMeters
  );
  const trail = course.trailSpline2D;
  const nKnots = knots.length;

  const samplesByProgress: SpatialSample[] = new Array(1001);
  let kIdx = 0;

  for (let i = 0; i <= 1000; i++) {
    const s = Math.round(i) / 1000;
    while (kIdx < nKnots - 2 && knots[kIdx + 1].s < s) {
      kIdx++;
    }

    const k0 = knots[kIdx];
    const k1 = knots[kIdx + 1];
    const hi = h[kIdx];
    const u = clamp((s - k0.s) / hi, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;

    const t0 = k0.t;
    const t1 = k1.t;
    const m0 = d[kIdx] * hi;
    const m1 = d[kIdx + 1] * hi;

    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;

    const t = h00 * t0 + h10 * m0 + h01 * t1 + h11 * m1;

    const dh00 = 6 * u2 - 6 * u;
    const dh10 = 3 * u2 - 4 * u + 1;
    const dh01 = -6 * u2 + 6 * u;
    const dh11 = 3 * u2 - 2 * u;

    const rawDtDs = (dh00 * t0 + dh10 * m0 + dh01 * t1 + dh11 * m1) / hi;
    const dtDs = clamp(rawDtDs, minSlope, maxSlope);

    const speedMps = totalDistanceMeters / dtDs;
    const speedKmh = round2(speedMps * 3.6);
    const speedMph = round2(speedKmh * KMH_TO_MPH);

    const d0 = Math.abs(k0.s - s);
    const d1 = Math.abs(k1.s - s);
    const nearestKnot = d0 <= d1 ? k0 : k1;
    const distToKnot = d0 <= d1 ? d0 : d1;
    const sampleProvenance: DataProvenance =
      distToKnot <= 0.018 ? nearestKnot.provenance : 'KINEMATIC_INTERPOLATED';
    const speedUncertaintyKmh = uncertaintyForProvenance(sampleProvenance, useModeA);

    const trailPt = trail[i];

    samplesByProgress[i] = {
      progressIndex: i,
      normalizedProgress: s,
      distanceMeters: round2(s * totalDistanceMeters),
      elapsedTimeSec: i === 0 ? 0 : i === 1000 ? totalTimeSec : round4(t),
      speedKmh,
      speedMph,
      speedUncertaintyKmh,
      provenance: sampleProvenance,
      gateNumber: useModeA ? nearestKnot.gateNumber : null,
      pitchRatio: trailPt.pitchRatio,
    };
  }

  for (let i = 1; i <= 1000; i++) {
    if (samplesByProgress[i].elapsedTimeSec <= samplesByProgress[i - 1].elapsedTimeSec) {
      samplesByProgress[i].elapsedTimeSec = round4(
        samplesByProgress[i - 1].elapsedTimeSec + 0.0005
      );
    }
  }
  samplesByProgress[1000].elapsedTimeSec = totalTimeSec;

  const numTimeTicks = Math.ceil(totalTimeSec * 100) + 1;
  const samplesByTime: TemporalSample[] = new Array(numTimeTicks);
  let progIdx = 0;

  for (let ti = 0; ti < numTimeTicks; ti++) {
    const rawT = ti * 0.01;
    const elapsedTimeSec = rawT > totalTimeSec ? totalTimeSec : rawT;
    while (
      progIdx < 999 &&
      samplesByProgress[progIdx + 1].elapsedTimeSec < elapsedTimeSec
    ) {
      progIdx++;
    }

    const p0 = samplesByProgress[progIdx];
    const p1 = samplesByProgress[progIdx + 1];
    const dt = p1.elapsedTimeSec - p0.elapsedTimeSec;
    const alpha = dt > 1e-6 ? clamp((elapsedTimeSec - p0.elapsedTimeSec) / dt, 0, 1) : 0;

    const s = p0.normalizedProgress + alpha * (p1.normalizedProgress - p0.normalizedProgress);
    const speedKmh = p0.speedKmh + alpha * (p1.speedKmh - p0.speedKmh);
    const distanceMeters = s * totalDistanceMeters;

    const trailIdx = (s * 1000 + 0.5) | 0;
    const safeTrailIdx = trailIdx < 0 ? 0 : trailIdx > 1000 ? 1000 : trailIdx;
    const trailPt = trail[safeTrailIdx];

    samplesByTime[ti] = {
      timeIndex: ti,
      elapsedTimeSec: Math.round(elapsedTimeSec * 100) / 100,
      normalizedProgress: Math.round(s * 10000) / 10000,
      distanceMeters: Math.round(distanceMeters),
      speedKmh: Math.round(speedKmh * 10) / 10,
      mapX: Math.round(trailPt.x),
      mapY: Math.round(trailPt.y),
    };
  }

  return {
    ...athleteMeta,
    samplesByProgress,
    samplesByTime,
  };
}

function applyOverridesToAnchors(
  anchors: CheckpointAnchor[],
  athleteId: string,
  overrides?: AnchorOverrideRecord[]
): CheckpointAnchor[] {
  if (!overrides || overrides.length === 0) {
    return anchors;
  }

  const overrideMap = new Map<string, AnchorOverrideRecord>();
  for (let i = 0; i < overrides.length; i++) {
    const ov = overrides[i];
    if (ov.athleteId === athleteId) {
      overrideMap.set(ov.anchorId, ov);
    }
  }

  if (overrideMap.size === 0) {
    return anchors;
  }

  return anchors.map((a) => {
    const match = overrideMap.get(a.anchorId);
    if (!match) {
      return a;
    }
    return {
      ...a,
      videoTimestampSec: match.videoTimestampSec,
      provenance: match.provenance ?? 'MANUALLY_ANNOTATED',
    };
  });
}

/**
 * Validates that an athlete's merged anchor list satisfies strict pairwise monotonicity:
 * t_{k-1} + 0.033s <= t_k <= t_{k+1} - 0.033s.
 */
export function validatePairwiseAnchorMonotonicity(
  anchors: CheckpointAnchor[],
  totalTimeSec: number
): { valid: boolean; error?: string } {
  const sorted = [...anchors].sort((a, b) => a.normalizedProgress - b.normalizedProgress);
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (!Number.isFinite(cur.videoTimestampSec) || cur.videoTimestampSec < 0) {
      return { valid: false, error: `Anchor ${cur.anchorId} has negative or non-finite timestamp` };
    }
    if (cur.videoTimestampSec > totalTimeSec) {
      return {
        valid: false,
        error: `Anchor ${cur.anchorId} (${cur.videoTimestampSec}s) exceeds run duration (${totalTimeSec}s)`,
      };
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (cur.videoTimestampSec < prev.videoTimestampSec + 0.033 - 1e-6) {
        return {
          valid: false,
          error: `Non-monotonic timestamp at ${cur.anchorId} (${cur.videoTimestampSec}s) vs ${prev.anchorId} (${prev.videoTimestampSec}s); minimum separation is 0.033s`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Re-solves the full RaceComparisonManifest in < 2ms given optional D1/coach anchor overrides
 * and optional Super-G GPS course map toggle state.
 */
export function solveRaceComparisonManifest(
  baseManifest: RaceComparisonManifest,
  overrides?: AnchorOverrideRecord[],
  courseMapEnabled?: boolean
): RaceComparisonManifest {
  const effectiveCourseMapEnabled =
    courseMapEnabled !== undefined
      ? baseManifest.courseProfile.hasGpsCourseMap && courseMapEnabled
      : baseManifest.courseProfile.courseMapEnabled;

  const updatedCourse: CourseProfile = {
    ...baseManifest.courseProfile,
    courseMapEnabled: effectiveCourseMapEnabled,
  };

  const modeUnchanged =
    effectiveCourseMapEnabled === baseManifest.courseProfile.courseMapEnabled;
  const hasOverrideA =
    overrides?.some((ov) => ov.athleteId === baseManifest.athleteA.athleteId) ?? false;
  const hasOverrideB =
    overrides?.some((ov) => ov.athleteId === baseManifest.athleteB.athleteId) ?? false;

  const solvedA =
    modeUnchanged &&
    !hasOverrideA &&
    baseManifest.athleteA.samplesByProgress.length === 1001 &&
    baseManifest.athleteA.samplesByTime.length > 0
      ? baseManifest.athleteA
      : solveAthleteTrajectory(
          updatedCourse,
          {
            ...baseManifest.athleteA,
            anchors: applyOverridesToAnchors(
              baseManifest.athleteA.anchors,
              baseManifest.athleteA.athleteId,
              overrides
            ),
          },
          effectiveCourseMapEnabled
        );

  const solvedB =
    modeUnchanged &&
    !hasOverrideB &&
    baseManifest.athleteB.samplesByProgress.length === 1001 &&
    baseManifest.athleteB.samplesByTime.length > 0
      ? baseManifest.athleteB
      : solveAthleteTrajectory(
          updatedCourse,
          {
            ...baseManifest.athleteB,
            anchors: applyOverridesToAnchors(
              baseManifest.athleteB.anchors,
              baseManifest.athleteB.athleteId,
              overrides
            ),
          },
          effectiveCourseMapEnabled
        );

  const { microSectors, coachingHighlights } = computeMicroSectorsAndHighlights(
    updatedCourse,
    solvedA,
    solvedB
  );

  return {
    raceId: baseManifest.raceId,
    isSyntheticDemo: baseManifest.isSyntheticDemo,
    provenanceDisclosure: baseManifest.provenanceDisclosure,
    courseProfile: updatedCourse,
    athleteA: solvedA,
    athleteB: solvedB,
    microSectors,
    coachingHighlights,
  };
}
