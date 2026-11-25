import type {
  CourseGatePoint,
  CourseProfile,
  RawSuperGSheetRow,
} from './types.js';

const SUPER_G_START_ELEVATION_M = 3337.0;
const DOWNHILL_START_ELEVATION_M = 3483.0;

interface Waypoint2D {
  s: number;
  x: number;
  y: number;
  elevationMeters: number;
  pitchRatio: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Evaluates a centripetal Catmull-Rom spline (alpha = 0.5) through 2D waypoints
 * parameterized by normalized progress s in [0, 1] at 1,001 uniform ticks.
 */
export function evaluateCatmullRomTrailSpline(waypoints: Waypoint2D[]): Waypoint2D[] {
  if (waypoints.length < 2) {
    throw new Error('At least 2 waypoints are required to build a trail spline');
  }

  const result: Waypoint2D[] = [];
  const n = waypoints.length;

  let segIdx = 0;
  for (let i = 0; i <= 1000; i++) {
    const targetS = i / 1000;
    while (segIdx < n - 2 && waypoints[segIdx + 1].s < targetS) {
      segIdx++;
    }

    const p1 = waypoints[segIdx];
    const p2 = waypoints[segIdx + 1];
    const p0 = segIdx > 0 ? waypoints[segIdx - 1] : p1;
    const p3 = segIdx + 2 < n ? waypoints[segIdx + 2] : p2;

    const span = Math.max(1e-9, p2.s - p1.s);
    const u = clamp((targetS - p1.s) / span, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;

    // Centripetal-stabilized Catmull-Rom tangents (tension = 0.5)
    const m1x = 0.5 * (p2.x - p0.x);
    const m2x = 0.5 * (p3.x - p1.x);
    const m1y = 0.5 * (p2.y - p0.y);
    const m2y = 0.5 * (p3.y - p1.y);

    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;

    const x = clamp(h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x, 0, 1000);
    const y = clamp(h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y, 0, 1000);
    const elevationMeters = p1.elevationMeters + u * (p2.elevationMeters - p1.elevationMeters);
    const pitchRatio = p1.pitchRatio + u * (p2.pitchRatio - p1.pitchRatio);

    result.push({
      s: Number(targetS.toFixed(3)),
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      elevationMeters: Number(elevationMeters.toFixed(2)),
      pitchRatio: Number(pitchRatio.toFixed(4)),
    });
  }

  return result;
}

/**
 * Reconstructs the Beaver Creek Men's Super-G CourseProfile from the 38-row GPS sheet.
 */
export function buildSuperGCourseProfile(
  rawRows: RawSuperGSheetRow[],
  courseMapEnabled = true
): CourseProfile {
  if (rawRows.length === 0) {
    throw new Error('rawRows cannot be empty');
  }

  let totalDistance = 0;
  let totalDrop = 0;
  for (const row of rawRows) {
    totalDistance += row.segmentDistanceMeters;
    totalDrop += row.verticalDropMeters;
  }

  totalDistance = Number(totalDistance.toFixed(2));
  totalDrop = Number(totalDrop.toFixed(2));

  // Integrate raw (X_k, Y_k) coordinates from 3D slope distance, vertical drop, and lateral offset
  const rawCoords: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let curX = 0;
  let curY = 0;
  let macroHeadingRad = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const k = i + 1;
    const d = row.segmentDistanceMeters;
    const dz = row.verticalDropMeters;
    const h = row.horizontalOffsetMeters;

    const fallStep = Math.sqrt(Math.max(0, d * d - dz * dz - h * h));
    // Gentle macro S-bend across Birds of Prey terrain plus alternating gate offset (-1)^k * h_k
    macroHeadingRad += (row.angleDeg * Math.PI) / 1800;
    const gateAlternatingOffset = (k % 2 === 0 ? 1 : -1) * h * 1.35;

    curY += fallStep;
    curX += Math.sin(macroHeadingRad) * fallStep * 0.35 + gateAlternatingOffset;
    rawCoords.push({ x: curX, y: curY });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of rawCoords) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  const normalizeX = (x: number): number =>
    Number((160 + ((x - minX) / spanX) * 680).toFixed(2));
  const normalizeY = (y: number): number =>
    Number((60 + ((y - minY) / spanY) * 880).toFixed(2));

  const gates: CourseGatePoint[] = [];
  const waypoints: Waypoint2D[] = [
    {
      s: 0,
      x: normalizeX(rawCoords[0].x),
      y: normalizeY(rawCoords[0].y),
      elevationMeters: SUPER_G_START_ELEVATION_M,
      pitchRatio: rawRows[0].pitchRatio,
    },
  ];

  let cumDist = 0;
  let cumDrop = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    cumDist = Math.round((cumDist + row.segmentDistanceMeters) * 100) / 100;
    cumDrop = Math.round((cumDrop + row.verticalDropMeters) * 100) / 100;
    const s = Math.round(clamp(cumDist / totalDistance, 0, 1) * 1000) / 1000;
    const mapX = normalizeX(rawCoords[i + 1].x);
    const mapY = normalizeY(rawCoords[i + 1].y);
    const elevationMeters = Math.round((SUPER_G_START_ELEVATION_M - cumDrop) * 100) / 100;

    gates.push({
      gateNumber: row.gateNumber,
      color: row.color,
      type: row.type,
      segmentDistanceMeters: row.segmentDistanceMeters,
      cumulativeDistanceMeters: cumDist,
      normalizedProgress: s,
      horizontalOffsetMeters: row.horizontalOffsetMeters,
      bearingRatio: row.bearingRatio,
      verticalDropMeters: row.verticalDropMeters,
      cumulativeDropMeters: cumDrop,
      pitchRatio: row.pitchRatio,
      angleDeg: row.angleDeg,
      mapX,
      mapY,
      elevationMeters,
    });

    waypoints.push({
      s,
      x: mapX,
      y: mapY,
      elevationMeters,
      pitchRatio: row.pitchRatio,
    });
  }

  // Ensure final waypoint has exact s = 1
  waypoints[waypoints.length - 1].s = 1;
  gates[gates.length - 1].normalizedProgress = 1;

  const trailSpline2D = evaluateCatmullRomTrailSpline(waypoints);

  return {
    raceId: 'beaver-creek-men-sg-2025',
    discipline: 'super-g',
    title: "2025 Beaver Creek Men's World Cup Super-G (Birds of Prey)",
    sourceVideoFilename: 'MEN SGWRLD CLN F 05-DEC-2025 10h42m59s29.mp4',
    feedType: 'CLN_F',
    hasGpsCourseMap: true,
    courseMapEnabled,
    totalDistanceMeters: totalDistance,
    totalVerticalDropMeters: totalDrop,
    gates,
    trailSpline2D,
  };
}

/**
 * Constructs the video-only Birds of Prey Downhill CourseProfile (s in [0, 1])
 * with the 6 canonical landmarks and nominal length 2,620.0m / vertical drop 757.0m.
 */
export function buildDownhillCourseProfile(): CourseProfile {
  const totalDistanceMeters = 2620.0;
  const totalVerticalDropMeters = 757.0;

  const landmarkSpecs: Array<{
    gateNumber: number;
    color: 'ORANGE' | 'FINISH';
    type: 'Landmark' | 'Split' | 'Finish';
    s: number;
    dropMeters: number;
    pitchRatio: number;
    angleDeg: number;
    mapX: number;
    mapY: number;
  }> = [
    {
      gateNumber: 1,
      color: 'ORANGE',
      type: 'Split',
      s: 0.18,
      dropMeters: 118.0,
      pitchRatio: 0.25,
      angleDeg: -14,
      mapX: 310,
      mapY: 215,
    },
    {
      gateNumber: 2,
      color: 'ORANGE',
      type: 'Landmark',
      s: 0.41,
      dropMeters: 196.0,
      pitchRatio: 0.46,
      angleDeg: 32,
      mapX: 540,
      mapY: 410,
    },
    {
      gateNumber: 3,
      color: 'ORANGE',
      type: 'Split',
      s: 0.63,
      dropMeters: 212.0,
      pitchRatio: 0.42,
      angleDeg: -28,
      mapX: 420,
      mapY: 615,
    },
    {
      gateNumber: 4,
      color: 'ORANGE',
      type: 'Landmark',
      s: 0.84,
      dropMeters: 146.0,
      pitchRatio: 0.31,
      angleDeg: 22,
      mapX: 640,
      mapY: 790,
    },
    {
      gateNumber: 5,
      color: 'FINISH',
      type: 'Finish',
      s: 1.0,
      dropMeters: 85.0,
      pitchRatio: 0.21,
      angleDeg: -6,
      mapX: 520,
      mapY: 940,
    },
  ];

  const gates: CourseGatePoint[] = [];
  const waypoints: Waypoint2D[] = [
    {
      s: 0,
      x: 220,
      y: 60,
      elevationMeters: DOWNHILL_START_ELEVATION_M,
      pitchRatio: 0.22,
    },
  ];

  let prevS = 0;
  let cumDrop = 0;

  for (const spec of landmarkSpecs) {
    const segDist = Number(((spec.s - prevS) * totalDistanceMeters).toFixed(2));
    const cumDist = Number((spec.s * totalDistanceMeters).toFixed(2));
    cumDrop = Number((cumDrop + spec.dropMeters).toFixed(2));
    const elevationMeters = Number((DOWNHILL_START_ELEVATION_M - cumDrop).toFixed(2));

    gates.push({
      gateNumber: spec.gateNumber,
      color: spec.color,
      type: spec.type,
      segmentDistanceMeters: segDist,
      cumulativeDistanceMeters: cumDist,
      normalizedProgress: spec.s,
      horizontalOffsetMeters: Number((segDist * 0.18).toFixed(2)),
      bearingRatio: 0.18,
      verticalDropMeters: spec.dropMeters,
      cumulativeDropMeters: cumDrop,
      pitchRatio: spec.pitchRatio,
      angleDeg: spec.angleDeg,
      mapX: spec.mapX,
      mapY: spec.mapY,
      elevationMeters,
    });

    waypoints.push({
      s: spec.s,
      x: spec.mapX,
      y: spec.mapY,
      elevationMeters,
      pitchRatio: spec.pitchRatio,
    });

    prevS = spec.s;
  }

  const trailSpline2D = evaluateCatmullRomTrailSpline(waypoints);

  return {
    raceId: 'beaver-creek-men-dh-2025',
    discipline: 'downhill',
    title: "2025 Beaver Creek Men's World Cup Downhill (Birds of Prey)",
    sourceVideoFilename: 'MEN DHWRLD DTY F 04-DEC-2025 10h27m59s29.mp4',
    feedType: 'DTY_F',
    hasGpsCourseMap: false,
    courseMapEnabled: false,
    totalDistanceMeters,
    totalVerticalDropMeters,
    gates,
    trailSpline2D,
  };
}
