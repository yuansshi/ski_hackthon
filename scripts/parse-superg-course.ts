import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSuperGCourseProfile } from '../src/shared/course-geometry.js';
import type { CourseProfile, RawSuperGSheetRow } from '../src/shared/types.js';

/**
 * Exact 38-row GPS gate survey from `2025-12-05_Beaver-Creek_WC_Men_SG_1Run.xlsx`
 * (Total Distance: 1,672.91m, Total Horizontal Offset: 319.27m, Total Vertical Drop: 528.80m).
 */
export const RAW_SUPERG_38_ROWS: RawSuperGSheetRow[] = [
  { gateNumber: 1, color: 'RED', type: 'Open', segmentDistanceMeters: 22.01, horizontalOffsetMeters: 6.39, bearingRatio: 0.29, verticalDropMeters: 7.68, pitchRatio: 0.35, angleDeg: -29 },
  { gateNumber: 2, color: 'BLUE', type: 'Open', segmentDistanceMeters: 34.48, horizontalOffsetMeters: 10.22, bearingRatio: 0.30, verticalDropMeters: 12.23, pitchRatio: 0.35, angleDeg: 33 },
  { gateNumber: 3, color: 'RED', type: 'Open', segmentDistanceMeters: 43.94, horizontalOffsetMeters: 11.87, bearingRatio: 0.27, verticalDropMeters: 17.82, pitchRatio: 0.41, angleDeg: -35 },
  { gateNumber: 4, color: 'BLUE', type: 'Open', segmentDistanceMeters: 45.46, horizontalOffsetMeters: 13.49, bearingRatio: 0.30, verticalDropMeters: 23.05, pitchRatio: 0.51, angleDeg: 53 },
  { gateNumber: 5, color: 'RED', type: 'Delayed', segmentDistanceMeters: 26.99, horizontalOffsetMeters: 6.54, bearingRatio: 0.24, verticalDropMeters: 10.98, pitchRatio: 0.41, angleDeg: 25 },
  { gateNumber: 6, color: 'BLUE', type: 'Open', segmentDistanceMeters: 41.94, horizontalOffsetMeters: 15.69, bearingRatio: 0.37, verticalDropMeters: 10.98, pitchRatio: 0.26, angleDeg: -46 },
  { gateNumber: 7, color: 'RED', type: 'Open', segmentDistanceMeters: 46.57, horizontalOffsetMeters: 11.67, bearingRatio: 0.25, verticalDropMeters: 24.64, pitchRatio: 0.53, angleDeg: 31 },
  { gateNumber: 8, color: 'BLUE', type: 'Open', segmentDistanceMeters: 50.86, horizontalOffsetMeters: 8.92, bearingRatio: 0.18, verticalDropMeters: 18.73, pitchRatio: 0.37, angleDeg: -24 },
  { gateNumber: 9, color: 'RED', type: 'Open', segmentDistanceMeters: 45.84, horizontalOffsetMeters: 8.29, bearingRatio: 0.18, verticalDropMeters: 21.77, pitchRatio: 0.47, angleDeg: 21 },
  { gateNumber: 10, color: 'BLUE', type: 'Open', segmentDistanceMeters: 53.33, horizontalOffsetMeters: 18.99, bearingRatio: 0.36, verticalDropMeters: 16.68, pitchRatio: 0.31, angleDeg: -47 },
  { gateNumber: 11, color: 'RED', type: 'Open', segmentDistanceMeters: 51.56, horizontalOffsetMeters: 13.15, bearingRatio: 0.26, verticalDropMeters: 25.35, pitchRatio: 0.49, angleDeg: 32 },
  { gateNumber: 12, color: 'BLUE', type: 'Open', segmentDistanceMeters: 54.35, horizontalOffsetMeters: 19.27, bearingRatio: 0.35, verticalDropMeters: 16.44, pitchRatio: 0.30, angleDeg: -46 },
  { gateNumber: 13, color: 'RED', type: 'Open', segmentDistanceMeters: 52.87, horizontalOffsetMeters: 13.28, bearingRatio: 0.25, verticalDropMeters: 25.09, pitchRatio: 0.47, angleDeg: 34 },
  { gateNumber: 14, color: 'BLUE', type: 'Open', segmentDistanceMeters: 49.31, horizontalOffsetMeters: 2.71, bearingRatio: 0.06, verticalDropMeters: 20.95, pitchRatio: 0.42, angleDeg: -7 },
  { gateNumber: 15, color: 'RED', type: 'Open', segmentDistanceMeters: 52.25, horizontalOffsetMeters: 9.33, bearingRatio: 0.18, verticalDropMeters: 18.56, pitchRatio: 0.36, angleDeg: 21 },
  { gateNumber: 16, color: 'BLUE', type: 'Open', segmentDistanceMeters: 54.41, horizontalOffsetMeters: 19.16, bearingRatio: 0.35, verticalDropMeters: 16.22, pitchRatio: 0.30, angleDeg: -46 },
  { gateNumber: 17, color: 'RED', type: 'Open', segmentDistanceMeters: 49.72, horizontalOffsetMeters: 8.69, bearingRatio: 0.17, verticalDropMeters: 19.65, pitchRatio: 0.40, angleDeg: -22 },
  { gateNumber: 18, color: 'BLUE', type: 'Open', segmentDistanceMeters: 51.06, horizontalOffsetMeters: 7.45, bearingRatio: 0.15, verticalDropMeters: 19.49, pitchRatio: 0.38, angleDeg: -25 },
  { gateNumber: 19, color: 'RED', type: 'Delayed', segmentDistanceMeters: 29.24, horizontalOffsetMeters: 3.71, bearingRatio: 0.13, verticalDropMeters: 8.43, pitchRatio: 0.29, angleDeg: -12 },
  { gateNumber: 20, color: 'BLUE', type: 'Open', segmentDistanceMeters: 47.02, horizontalOffsetMeters: 11.70, bearingRatio: 0.25, verticalDropMeters: 9.08, pitchRatio: 0.19, angleDeg: 29 },
  { gateNumber: 21, color: 'RED', type: 'Open', segmentDistanceMeters: 49.21, horizontalOffsetMeters: 3.60, bearingRatio: 0.07, verticalDropMeters: 15.23, pitchRatio: 0.31, angleDeg: 9 },
  { gateNumber: 22, color: 'BLUE', type: 'Open', segmentDistanceMeters: 49.46, horizontalOffsetMeters: 13.93, bearingRatio: 0.28, verticalDropMeters: 11.02, pitchRatio: 0.22, angleDeg: 44 },
  { gateNumber: 23, color: 'RED', type: 'Delayed', segmentDistanceMeters: 31.85, horizontalOffsetMeters: 5.19, bearingRatio: 0.16, verticalDropMeters: 10.26, pitchRatio: 0.32, angleDeg: 16 },
  { gateNumber: 24, color: 'BLUE', type: 'Open', segmentDistanceMeters: 48.02, horizontalOffsetMeters: 12.56, bearingRatio: 0.26, verticalDropMeters: 8.03, pitchRatio: 0.17, angleDeg: -30 },
  { gateNumber: 25, color: 'RED', type: 'Open', segmentDistanceMeters: 51.28, horizontalOffsetMeters: 4.86, bearingRatio: 0.09, verticalDropMeters: 16.65, pitchRatio: 0.32, angleDeg: 12 },
  { gateNumber: 26, color: 'BLUE', type: 'Open', segmentDistanceMeters: 49.01, horizontalOffsetMeters: 2.25, bearingRatio: 0.05, verticalDropMeters: 14.55, pitchRatio: 0.30, angleDeg: 6 },
  { gateNumber: 27, color: 'RED', type: 'Open', segmentDistanceMeters: 44.60, horizontalOffsetMeters: 7.58, bearingRatio: 0.17, verticalDropMeters: 7.13, pitchRatio: 0.16, angleDeg: 19 },
  { gateNumber: 28, color: 'BLUE', type: 'Open', segmentDistanceMeters: 48.21, horizontalOffsetMeters: 3.23, bearingRatio: 0.07, verticalDropMeters: 8.88, pitchRatio: 0.18, angleDeg: -8 },
  { gateNumber: 29, color: 'RED', type: 'Open', segmentDistanceMeters: 44.47, horizontalOffsetMeters: 11.12, bearingRatio: 0.25, verticalDropMeters: 3.80, pitchRatio: 0.09, angleDeg: 31 },
  { gateNumber: 30, color: 'BLUE', type: 'Open', segmentDistanceMeters: 40.31, horizontalOffsetMeters: 2.58, bearingRatio: 0.06, verticalDropMeters: 3.02, pitchRatio: 0.07, angleDeg: -8 },
  { gateNumber: 31, color: 'RED', type: 'Open', segmentDistanceMeters: 34.23, horizontalOffsetMeters: 1.85, bearingRatio: 0.05, verticalDropMeters: 4.41, pitchRatio: 0.13, angleDeg: -6 },
  { gateNumber: 32, color: 'BLUE', type: 'Open', segmentDistanceMeters: 43.85, horizontalOffsetMeters: 6.41, bearingRatio: 0.15, verticalDropMeters: 7.51, pitchRatio: 0.17, angleDeg: -17 },
  { gateNumber: 33, color: 'RED', type: 'Open', segmentDistanceMeters: 49.64, horizontalOffsetMeters: 9.30, bearingRatio: 0.19, verticalDropMeters: 20.37, pitchRatio: 0.41, angleDeg: 25 },
  { gateNumber: 34, color: 'BLUE', type: 'Open', segmentDistanceMeters: 46.53, horizontalOffsetMeters: 12.17, bearingRatio: 0.26, verticalDropMeters: 21.32, pitchRatio: 0.46, angleDeg: -32 },
  { gateNumber: 35, color: 'RED', type: 'Open', segmentDistanceMeters: 48.83, horizontalOffsetMeters: 1.20, bearingRatio: 0.02, verticalDropMeters: 13.23, pitchRatio: 0.27, angleDeg: -3 },
  { gateNumber: 36, color: 'BLUE', type: 'Open', segmentDistanceMeters: 38.02, horizontalOffsetMeters: 0.02, bearingRatio: 0.00, verticalDropMeters: 5.98, pitchRatio: 0.16, angleDeg: 0 },
  { gateNumber: 37, color: 'RED', type: 'Open', segmentDistanceMeters: 43.82, horizontalOffsetMeters: 0.90, bearingRatio: 0.02, verticalDropMeters: 11.21, pitchRatio: 0.26, angleDeg: 8 },
  { gateNumber: 38, color: 'FINISH', type: 'Finish', segmentDistanceMeters: 8.36, horizontalOffsetMeters: 0.00, bearingRatio: 0.00, verticalDropMeters: 2.38, pitchRatio: 0.28, angleDeg: 0 },
];

export function generateSuperGCourseJson(outputPath?: string): CourseProfile {
  const course = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(course, null, 2) + '\n', 'utf-8');
  }
  return course;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const outFile = path.resolve(process.cwd(), 'public/data/super-g-course.json');
  const profile = generateSuperGCourseJson(outFile);
  console.log(
    `[parse-superg-course] Wrote ${outFile} (${profile.gates.length} gates, ${profile.totalDistanceMeters}m length, ${profile.totalVerticalDropMeters}m drop)`
  );
}
