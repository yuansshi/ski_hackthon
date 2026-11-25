import { describe, expect, it } from 'vitest';
import {
  buildDownhillCourseProfile,
  buildSuperGCourseProfile,
  evaluateCatmullRomTrailSpline,
} from '../src/shared/course-geometry.js';
import { RAW_SUPERG_38_ROWS } from '../scripts/parse-superg-course.js';

describe('Course Geometry Reconstruction (course-geometry.ts)', () => {
  it('parses all 38 Beaver Creek Super-G GPS rows to exact 1,672.91m distance and 528.80m drop', () => {
    const course = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);

    expect(course.raceId).toBe('beaver-creek-men-sg-2025');
    expect(course.discipline).toBe('super-g');
    expect(course.hasGpsCourseMap).toBe(true);
    expect(course.courseMapEnabled).toBe(true);
    expect(course.gates).toHaveLength(38);
    expect(course.totalDistanceMeters).toBeCloseTo(1672.91, 2);
    expect(course.totalVerticalDropMeters).toBeCloseTo(528.8, 2);

    // Verify strictly increasing progress s_0 = 0 < s_1 < ... < s_38 = 1
    let prevS = 0;
    for (let i = 0; i < course.gates.length; i++) {
      const gate = course.gates[i];
      expect(gate.gateNumber).toBe(i + 1);
      expect(gate.normalizedProgress).toBeGreaterThan(prevS);
      expect(gate.mapX).toBeGreaterThanOrEqual(0);
      expect(gate.mapX).toBeLessThanOrEqual(1000);
      expect(gate.mapY).toBeGreaterThanOrEqual(0);
      expect(gate.mapY).toBeLessThanOrEqual(1000);
      prevS = gate.normalizedProgress;
    }
    expect(course.gates[37].normalizedProgress).toBe(1);
    expect(course.gates[37].type).toBe('Finish');

    // Verify 1,001 spline points in [0, 1000]
    expect(course.trailSpline2D).toHaveLength(1001);
    expect(course.trailSpline2D[0].s).toBe(0);
    expect(course.trailSpline2D[1000].s).toBe(1);
    for (const pt of course.trailSpline2D) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(1000);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(1000);
    }
  });

  it('constructs the Downhill Birds of Prey schematic profile with 2,620m length and 757m drop', () => {
    const dh = buildDownhillCourseProfile();
    expect(dh.raceId).toBe('beaver-creek-men-dh-2025');
    expect(dh.discipline).toBe('downhill');
    expect(dh.hasGpsCourseMap).toBe(false);
    expect(dh.courseMapEnabled).toBe(false);
    expect(dh.totalDistanceMeters).toBe(2620);
    expect(dh.totalVerticalDropMeters).toBe(757);
    expect(dh.gates).toHaveLength(5);
    expect(dh.trailSpline2D).toHaveLength(1001);
  });

  it('rejects empty rawRows or insufficient waypoints', () => {
    expect(() => buildSuperGCourseProfile([])).toThrow(/rawRows cannot be empty/);
    expect(() =>
      evaluateCatmullRomTrailSpline([
        { s: 0, x: 100, y: 100, elevationMeters: 3000, pitchRatio: 0.3 },
      ])
    ).toThrow(/At least 2 waypoints/);
  });
});
