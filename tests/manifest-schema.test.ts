import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataProvenance, RaceComparisonManifest } from '../src/shared/types.js';
import {
  detectShotCutsFromLumaDiff,
  matchAnchorsToPriorWindows,
} from '../scripts/extract-anchors.js';
import { predictForwardPriorGateWindows } from '../src/shared/kinematic-solver.js';
import { buildSuperGCourseProfile } from '../src/shared/course-geometry.js';
import { RAW_SUPERG_38_ROWS } from '../scripts/parse-superg-course.js';

const VALID_PROVENANCE = new Set<DataProvenance>([
  'OCR_MEASURED',
  'GNSS_DERIVED',
  'GATE_CALIBRATED',
  'KINEMATIC_INTERPOLATED',
  'MANUALLY_ANNOTATED',
  'SIMULATED',
]);

describe('Pre-Computed Manifest Invariants & Extraction Pipeline (manifest-schema.test.ts)', () => {
  it('validates generated Super-G and Downhill JSON manifests on disk', () => {
    const sgPath = path.resolve(
      process.cwd(),
      'public/data/beaver-creek-men-sg-2025.json'
    );
    const dhPath = path.resolve(
      process.cwd(),
      'public/data/beaver-creek-men-dh-2025.json'
    );

    expect(fs.existsSync(sgPath)).toBe(true);
    expect(fs.existsSync(dhPath)).toBe(true);

    const sg = JSON.parse(fs.readFileSync(sgPath, 'utf-8')) as RaceComparisonManifest;
    const dh = JSON.parse(fs.readFileSync(dhPath, 'utf-8')) as RaceComparisonManifest;

    expect(sg.isSyntheticDemo).toBe(true);
    for (const athlete of [sg.athleteA, sg.athleteB]) {
      expect(athlete.anchors.every((anchor) =>
        anchor.provenance === 'SIMULATED' || anchor.provenance === 'KINEMATIC_INTERPOLATED'
      )).toBe(true);
    }
    for (const athlete of [dh.athleteA, dh.athleteB]) {
      expect(athlete.anchors.every((anchor) =>
        anchor.provenance === (dh.isSyntheticDemo ? 'SIMULATED' : 'GNSS_DERIVED') &&
        anchor.ocrSpeedKmh === null
      )).toBe(true);
    }

    for (const manifest of [sg, dh]) {
      expect(manifest.athleteA.samplesByProgress).toHaveLength(1001);
      expect(manifest.athleteB.samplesByProgress).toHaveLength(1001);

      for (const athlete of [manifest.athleteA, manifest.athleteB]) {
        for (let i = 0; i <= 1000; i++) {
          const sample = athlete.samplesByProgress[i];
          expect(sample.progressIndex).toBe(i);
          expect(sample.speedKmh).toBeGreaterThan(15);
          expect(sample.speedKmh).toBeLessThan(150);
          expect(VALID_PROVENANCE.has(sample.provenance)).toBe(true);
          if (i > 0) {
            expect(sample.elapsedTimeSec).toBeGreaterThan(
              athlete.samplesByProgress[i - 1].elapsedTimeSec
            );
          }
        }
        expect(athlete.samplesByTime.length).toBe(
          Math.ceil(athlete.totalTimeSec * 100) + 1
        );
      }

      expect(manifest.microSectors.length).toBeGreaterThanOrEqual(5);
      expect(manifest.coachingHighlights.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('segments camera cuts and matches prior-windowed gate candidates without index drift', () => {
    const cuts = detectShotCutsFromLumaDiff([
      { timestampSec: 1.0, lumaDiff: 0.12 },
      { timestampSec: 6.4, lumaDiff: 0.65 },
      { timestampSec: 6.6, lumaDiff: 0.55 }, // suppressed by 0.5s debounce
      { timestampSec: 14.2, lumaDiff: 0.49 },
    ]);
    expect(cuts).toEqual([6.4, 14.2]);

    const course = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
    const windows = predictForwardPriorGateWindows(course, 71.48);

    const matched = matchAnchorsToPriorWindows(
      windows,
      [
        {
          gateNumber: 1,
          rawVideoSec: 2.0 + windows[0].expectedTimeSec,
          confidenceSec: 0.02,
        },
        {
          gateNumber: 2,
          rawVideoSec: 99.0, // Out of window -> must fall back to KINEMATIC_INTERPOLATED
          confidenceSec: 0.05,
        },
      ],
      2.0,
      2.0 + 71.48,
      71.48
    );

    expect(matched[0].provenance).toBe('GATE_CALIBRATED');
    expect(matched[1].provenance).toBe('KINEMATIC_INTERPOLATED');
    expect(matched[2].provenance).toBe('KINEMATIC_INTERPOLATED');
  });
});
