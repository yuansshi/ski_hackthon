import { describe, expect, it } from 'vitest';
import {
  buildDownhillCourseProfile,
  buildSuperGCourseProfile,
} from '../src/shared/course-geometry.js';
import {
  predictForwardPriorGateWindows,
  solveAthleteTrajectory,
} from '../src/shared/kinematic-solver.js';
import { computeMicroSectorsAndHighlights } from '../src/shared/coaching-attribution.js';
import type { CheckpointAnchor } from '../src/shared/types.js';
import { RAW_SUPERG_38_ROWS } from '../scripts/parse-superg-course.js';

describe('Turn Tax vs. Glide Carry Attribution (coaching-attribution.ts)', () => {
  it('exhaustively partitions sectorDeltaSec into turnExecutionDeltaSec + glideCarryDeltaSec in Mode A and Mode B', () => {
    const sgCourse = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
    const winA = predictForwardPriorGateWindows(sgCourse, 71.48);
    const winB = predictForwardPriorGateWindows(sgCourse, 72.18);

    const anchorsA: CheckpointAnchor[] = winA.map((w) => ({
      anchorId: `gate-${w.gateNumber}`,
      label: `Gate ${w.gateNumber}`,
      gateNumber: w.gateNumber,
      normalizedProgress: w.normalizedProgress,
      videoTimestampSec: w.expectedTimeSec,
      expectedWindowMinSec: w.windowMinSec,
      expectedWindowMaxSec: w.windowMaxSec,
      provenance: 'GATE_CALIBRATED',
      confidenceSec: 0.03,
      ocrSpeedKmh: null,
    }));

    // Give Athlete B extra time loss in steep turns (Gates 7-12) and flat glides (Gates 26-31)
    const anchorsB: CheckpointAnchor[] = winB.map((w) => {
      let extraDelay = 0;
      if (w.gateNumber >= 10) extraDelay += 0.18;
      if (w.gateNumber >= 28) extraDelay += 0.22;
      return {
        anchorId: `gate-${w.gateNumber}`,
        label: `Gate ${w.gateNumber}`,
        gateNumber: w.gateNumber,
        normalizedProgress: w.normalizedProgress,
        videoTimestampSec: Math.min(72.18, Number((w.expectedTimeSec + extraDelay).toFixed(4))),
        expectedWindowMinSec: w.windowMinSec,
        expectedWindowMaxSec: w.windowMaxSec,
        provenance: 'GATE_CALIBRATED',
        confidenceSec: 0.03,
        ocrSpeedKmh: null,
      };
    });

    const solvedA = solveAthleteTrajectory(
      sgCourse,
      {
        athleteId: 'odermatt-sg',
        athleteName: 'Marco Odermatt',
        bibNumber: 7,
        countryCode: 'SUI',
        clipUrl: '/api/clips/sg-athlete-a.mp4',
        startClipOffsetSec: 2,
        totalTimeSec: 71.48,
        nativeFps: 29.97002997,
        anchors: anchorsA,
      },
      true
    );

    const solvedB = solveAthleteTrajectory(
      sgCourse,
      {
        athleteId: 'cochran-siegle-sg',
        athleteName: 'Ryan Cochran-Siegle',
        bibNumber: 11,
        countryCode: 'USA',
        clipUrl: '/api/clips/sg-athlete-b.mp4',
        startClipOffsetSec: 2,
        totalTimeSec: 72.18,
        nativeFps: 29.97002997,
        anchors: anchorsB,
      },
      true
    );

    const { microSectors, coachingHighlights } = computeMicroSectorsAndHighlights(
      sgCourse,
      solvedA,
      solvedB
    );

    expect(microSectors).toHaveLength(6);
    for (const sec of microSectors) {
      expect(sec.turnExecutionDeltaSec + sec.glideCarryDeltaSec).toBeCloseTo(
        sec.sectorDeltaSec,
        5
      );
    }
    expect(coachingHighlights.length).toBeGreaterThan(0);
    for (const hl of coachingHighlights) {
      expect(Math.abs(hl.timeSwingSec)).toBeGreaterThanOrEqual(0.12);
      expect(hl.summaryText.length).toBeGreaterThan(20);
      expect(hl.uncertaintyNote).toContain('Provenance:');
    }

    // Also test Mode B (Downhill) attribution
    const dhCourse = buildDownhillCourseProfile();
    const dhA = solveAthleteTrajectory(
      dhCourse,
      {
        athleteId: 'odermatt-dh',
        athleteName: 'Marco Odermatt',
        bibNumber: 8,
        countryCode: 'SUI',
        clipUrl: '/api/clips/dh-athlete-a.mp4',
        startClipOffsetSec: 2,
        totalTimeSec: 99.84,
        nativeFps: 29.97002997,
        anchors: dhCourse.gates.map((g, idx) => ({
          anchorId: `dh-${idx + 1}`,
          label: `Split ${idx + 1}`,
          gateNumber: null,
          normalizedProgress: g.normalizedProgress,
          videoTimestampSec: Number((g.normalizedProgress * 99.84).toFixed(2)),
          expectedWindowMinSec: 0,
          expectedWindowMaxSec: 105,
          provenance: 'OCR_MEASURED',
          confidenceSec: 0.02,
          ocrSpeedKmh: 118,
        })),
      },
      false
    );
    const dhB = solveAthleteTrajectory(
      dhCourse,
      {
        athleteId: 'bennett-dh',
        athleteName: 'Bryce Bennett',
        bibNumber: 14,
        countryCode: 'USA',
        clipUrl: '/api/clips/dh-athlete-b.mp4',
        startClipOffsetSec: 2,
        totalTimeSec: 100.41,
        nativeFps: 29.97002997,
        anchors: dhCourse.gates.map((g, idx) => ({
          anchorId: `dh-${idx + 1}`,
          label: `Split ${idx + 1}`,
          gateNumber: null,
          normalizedProgress: g.normalizedProgress,
          videoTimestampSec: Number((g.normalizedProgress * 100.41).toFixed(2)),
          expectedWindowMinSec: 0,
          expectedWindowMaxSec: 105,
          provenance: 'OCR_MEASURED',
          confidenceSec: 0.02,
          ocrSpeedKmh: 115,
        })),
      },
      false
    );

    const dhResult = computeMicroSectorsAndHighlights(dhCourse, dhA, dhB);
    expect(dhResult.microSectors).toHaveLength(5);
    for (const sec of dhResult.microSectors) {
      expect(sec.turnExecutionDeltaSec + sec.glideCarryDeltaSec).toBeCloseTo(
        sec.sectorDeltaSec,
        5
      );
    }
  });
});
