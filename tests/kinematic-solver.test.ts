import { describe, expect, it } from 'vitest';
import {
  buildDownhillCourseProfile,
  buildSuperGCourseProfile,
} from '../src/shared/course-geometry.js';
import {
  calibratePtsTimebase,
  predictForwardPriorGateWindows,
  solveAthleteTrajectory,
  solveRaceComparisonManifest,
  validatePairwiseAnchorMonotonicity,
} from '../src/shared/kinematic-solver.js';
import type { CheckpointAnchor, RaceComparisonManifest } from '../src/shared/types.js';
import { RAW_SUPERG_38_ROWS } from '../scripts/parse-superg-course.js';

describe('Kinematic Solver & NTSC Calibration (kinematic-solver.ts)', () => {
  it('eliminates 29.97 fps NTSC drift via calibratePtsTimebase()', () => {
    const officialDurationSec = 71.48;
    // Uncalibrated 30.00 fps frame count vs 29.97002997 fps (1001/30000)
    const startWandSec = 4.2;
    const finishBeamSec = startWandSec + officialDurationSec * (1001 / 1000);

    expect(
      calibratePtsTimebase(startWandSec, startWandSec, finishBeamSec, officialDurationSec)
    ).toBeCloseTo(0, 5);
    expect(
      calibratePtsTimebase(finishBeamSec, startWandSec, finishBeamSec, officialDurationSec)
    ).toBeCloseTo(officialDurationSec, 5);

    expect(() => calibratePtsTimebase(10, 15, 10, 70)).toThrow();
  });

  it('prevents gate-index shift when 4 consecutive gates are occluded during a camera cut', () => {
    const course = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
    const totalTimeA = 71.48;
    const windows = predictForwardPriorGateWindows(course, totalTimeA);
    expect(windows).toHaveLength(38);
    expect(() => predictForwardPriorGateWindows(course, 0)).toThrow();
    expect(
      predictForwardPriorGateWindows({ ...course, gates: [] }, totalTimeA)
    ).toEqual([]);

    // Simulate 4 consecutively occluded gates (Gates 11, 12, 13, 14) marked KINEMATIC_INTERPOLATED
    const anchors: CheckpointAnchor[] = windows.map((w) => {
      const isOccluded = w.gateNumber >= 11 && w.gateNumber <= 14;
      return {
        anchorId: `gate-${w.gateNumber}`,
        label: `Gate ${w.gateNumber}`,
        gateNumber: w.gateNumber,
        normalizedProgress: w.normalizedProgress,
        videoTimestampSec: w.expectedTimeSec,
        expectedWindowMinSec: w.windowMinSec,
        expectedWindowMaxSec: w.windowMaxSec,
        provenance: isOccluded ? 'KINEMATIC_INTERPOLATED' : 'GATE_CALIBRATED',
        confidenceSec: isOccluded ? 0.08 : 0.03,
        ocrSpeedKmh: null,
      };
    });

    const solved = solveAthleteTrajectory(
      course,
      {
        athleteId: 'odermatt-sg',
        athleteName: 'Marco Odermatt',
        bibNumber: 7,
        countryCode: 'SUI',
        clipUrl: '/api/clips/sg-athlete-a.mp4',
        startClipOffsetSec: 2.0,
        totalTimeSec: totalTimeA,
        nativeFps: 29.97002997,
        anchors,
      },
      true
    );

    expect(solved.samplesByProgress).toHaveLength(1001);
    // Gate 15 (non-occluded) must remain aligned to its exact expectedTimeSec without index shift
    const gate15ProgressIdx = Math.round(windows[14].normalizedProgress * 1000);
    expect(solved.samplesByProgress[gate15ProgressIdx].elapsedTimeSec).toBeCloseTo(
      windows[14].expectedTimeSec,
      2
    );
    expect(solved.samplesByProgress[gate15ProgressIdx].provenance).toBe('GATE_CALIBRATED');
    expect(solved.samplesByProgress[gate15ProgressIdx].speedUncertaintyKmh).toBe(1.5);

    // Occluded Gate 12 must be marked KINEMATIC_INTERPOLATED with widened +-3.5 km/h uncertainty
    const gate12ProgressIdx = Math.round(windows[11].normalizedProgress * 1000);
    expect(solved.samplesByProgress[gate12ProgressIdx].provenance).toBe(
      'KINEMATIC_INTERPOLATED'
    );
    expect(solved.samplesByProgress[gate12ProgressIdx].speedUncertaintyKmh).toBe(3.5);
  });

  it('enforces PCHIP monotonicity, matches split deltas to < 0.005s, and re-solves in < 2ms', () => {
    const course = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
    const windowsA = predictForwardPriorGateWindows(course, 71.48);
    const windowsB = predictForwardPriorGateWindows(course, 71.92);

    const anchorsA: CheckpointAnchor[] = windowsA.map((w) => ({
      anchorId: `gate-${w.gateNumber}`,
      label: `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: w.expectedTimeSec,
      expectedWindowMinSec: w.windowMinSec,
      expectedWindowMaxSec: w.windowMaxSec,
      provenance: 'GATE_CALIBRATED',
      confidenceSec: 0.03,
      ocrSpeedKmh: w.gateNumber === 20 ? 104.5 : null,
    }));

    const anchorsB: CheckpointAnchor[] = windowsB.map((w) => ({
      anchorId: `gate-${w.gateNumber}`,
      label: `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: w.expectedTimeSec,
      expectedWindowMinSec: w.windowMinSec,
      expectedWindowMaxSec: w.windowMaxSec,
      provenance: 'GATE_CALIBRATED',
      confidenceSec: 0.03,
      ocrSpeedKmh: w.gateNumber === 20 ? 101.2 : null,
    }));

    const baseManifest: RaceComparisonManifest = {
      raceId: course.raceId,
      courseProfile: course,
      athleteA: {
        athleteId: 'odermatt-sg',
        athleteName: 'Marco Odermatt',
        bibNumber: 7,
        countryCode: 'SUI',
        clipUrl: '/api/clips/sg-athlete-a.mp4',
        startClipOffsetSec: 2.0,
        totalTimeSec: 71.48,
        nativeFps: 29.97002997,
        anchors: anchorsA,
        samplesByProgress: [],
        samplesByTime: [],
      },
      athleteB: {
        athleteId: 'cochran-siegle-sg',
        athleteName: 'Ryan Cochran-Siegle',
        bibNumber: 11,
        countryCode: 'USA',
        clipUrl: '/api/clips/sg-athlete-b.mp4',
        startClipOffsetSec: 2.0,
        totalTimeSec: 71.92,
        nativeFps: 29.97002997,
        anchors: anchorsB,
        samplesByProgress: [],
        samplesByTime: [],
      },
      microSectors: [],
      coachingHighlights: [],
    };

    // Compute initial baseline manifest and warm up JIT
    const hydratedBase = solveRaceComparisonManifest(baseManifest);
    let minElapsedMs = Infinity;
    let solved = hydratedBase;
    for (let w = 0; w < 5; w++) {
      const t0 = performance.now();
      solved = solveRaceComparisonManifest(
        hydratedBase,
        [
          {
            raceId: course.raceId,
            athleteId: 'cochran-siegle-sg',
            anchorId: 'gate-12',
            videoTimestampSec: Number((windowsB[11].expectedTimeSec + 0.067).toFixed(4)),
            provenance: 'MANUALLY_ANNOTATED',
          },
        ],
        true
      );
      const dt = performance.now() - t0;
      if (dt < minElapsedMs) minElapsedMs = dt;
    }

    expect(minElapsedMs).toBeLessThan(2.0);

    // Strictly increasing elapsedTimeSec and positive speed everywhere
    for (let i = 1; i <= 1000; i++) {
      expect(solved.athleteA.samplesByProgress[i].elapsedTimeSec).toBeGreaterThan(
        solved.athleteA.samplesByProgress[i - 1].elapsedTimeSec
      );
      expect(solved.athleteA.samplesByProgress[i].speedKmh).toBeGreaterThan(0);
    }

    // Finish delta t_A(1.0) - t_B(1.0) matches 71.48 - 71.92 = -0.44s within < 0.005s
    const finishDelta =
      solved.athleteA.samplesByProgress[1000].elapsedTimeSec -
      solved.athleteB.samplesByProgress[1000].elapsedTimeSec;
    expect(Math.abs(finishDelta - (71.48 - 71.92))).toBeLessThan(0.005);

    // Also verify Mode B (courseMapEnabled = false) and Downhill Mode B
    const solvedModeB = solveRaceComparisonManifest(solved, [], false);
    expect(solvedModeB.courseProfile.courseMapEnabled).toBe(false);
    expect(solvedModeB.athleteA.samplesByProgress[500].gateNumber).toBeNull();

    const dhCourse = buildDownhillCourseProfile();
    const dhAnchors: CheckpointAnchor[] = dhCourse.gates.map((g, idx) => ({
      anchorId: `dh-split-${idx + 1}`,
      label: `Split ${idx + 1}`,
      gateNumber: null,
      normalizedProgress: g.normalizedProgress,
      videoTimestampSec: Number((g.normalizedProgress * 99.84).toFixed(2)),
      expectedWindowMinSec: 0,
      expectedWindowMaxSec: 100,
      provenance: idx % 2 === 0 ? 'OCR_MEASURED' : 'GATE_CALIBRATED',
      confidenceSec: 0.02,
      ocrSpeedKmh: idx === 2 ? 124.8 : null,
    }));
    const dhSolved = solveAthleteTrajectory(
      dhCourse,
      {
        athleteId: 'odermatt-dh',
        athleteName: 'Marco Odermatt',
        bibNumber: 8,
        countryCode: 'SUI',
        clipUrl: '/api/clips/dh-athlete-a.mp4',
        startClipOffsetSec: 2.0,
        totalTimeSec: 99.84,
        nativeFps: 29.97002997,
        anchors: dhAnchors,
      },
      false
    );
    expect(dhSolved.samplesByProgress).toHaveLength(1001);
    expect(dhSolved.samplesByTime.length).toBeGreaterThan(9900);

    // Validate pairwise anchor monotonicity helper
    expect(validatePairwiseAnchorMonotonicity(anchorsA, 71.48).valid).toBe(true);
    const badAnchors = anchorsA.map((a, idx) =>
      idx === 5 ? { ...a, videoTimestampSec: anchorsA[4].videoTimestampSec } : a
    );
    expect(validatePairwiseAnchorMonotonicity(badAnchors, 71.48).valid).toBe(false);
    expect(
      validatePairwiseAnchorMonotonicity(
        [{ ...anchorsA[0], videoTimestampSec: -1 }],
        71.48
      ).valid
    ).toBe(false);
    expect(
      validatePairwiseAnchorMonotonicity(
        [{ ...anchorsA[0], videoTimestampSec: 999 }],
        71.48
      ).valid
    ).toBe(false);
  });
});
