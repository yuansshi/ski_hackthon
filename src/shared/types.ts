export type Discipline = 'super-g' | 'downhill';

export type DataProvenance =
  | 'OCR_MEASURED'
  | 'GNSS_DERIVED'
  | 'GATE_CALIBRATED'
  | 'KINEMATIC_INTERPOLATED'
  | 'MANUALLY_ANNOTATED'
  | 'SIMULATED';

export type GateColor = 'RED' | 'BLUE' | 'ORANGE' | 'FINISH';
export type GateType = 'Open' | 'Delayed' | 'Landmark' | 'Split' | 'Finish';

export interface RawSuperGSheetRow {
  gateNumber: number; // 1..37, 38 = Finish
  color: GateColor;
  type: GateType;
  segmentDistanceMeters: number;
  horizontalOffsetMeters: number;
  bearingRatio: number; // H. Offset / Distance from GPS sheet
  verticalDropMeters: number;
  pitchRatio: number; // Vertical Drop / Distance
  angleDeg: number;
}

export interface CourseGatePoint {
  gateNumber: number;
  color: GateColor;
  type: GateType;
  segmentDistanceMeters: number;
  cumulativeDistanceMeters: number;
  normalizedProgress: number; // s in [0, 1]
  horizontalOffsetMeters: number;
  bearingRatio: number; // H. Offset / Distance from GPS sheet
  verticalDropMeters: number;
  cumulativeDropMeters: number;
  pitchRatio: number; // Drop / Dist
  angleDeg: number;
  mapX: number; // Normalized 2D track X in [0, 1000]
  mapY: number; // Normalized 2D track Y in [0, 1000]
  elevationMeters: number;
}

export interface CourseProfile {
  raceId: string;
  discipline: Discipline;
  title: string;
  sourceVideoFilename: string;
  feedType: 'CLN_F' | 'DTY_F';
  hasGpsCourseMap: boolean;
  courseMapEnabled: boolean;
  totalDistanceMeters: number;
  totalVerticalDropMeters: number;
  gates: CourseGatePoint[];
  trailSpline2D: Array<{
    s: number;
    x: number;
    y: number;
    elevationMeters: number;
    pitchRatio: number;
  }>;
}

export interface CheckpointAnchor {
  anchorId: string; // e.g., "gate-12" or "split-2"
  label: string;
  gateNumber: number | null;
  normalizedProgress: number; // s in [0, 1]
  videoTimestampSec: number; // PTS-calibrated timestamp relative to start wand = 0
  expectedWindowMinSec: number;
  expectedWindowMaxSec: number;
  provenance: DataProvenance;
  confidenceSec: number;
  ocrSpeedKmh: number | null;
  gnssSpeedKmh?: number;
}

export interface AnchorOverrideRecord {
  raceId: string;
  athleteId: string;
  anchorId: string;
  videoTimestampSec: number;
  provenance: DataProvenance;
  updatedAt?: string;
}

export interface PutAnchorOverridesRequest {
  athleteId: string;
  overrides: Array<{
    anchorId: string;
    videoTimestampSec: number;
  }>;
}

export interface RaceCatalogItem {
  raceId: string;
  discipline: Discipline;
  title: string;
  hasGpsCourseMap: boolean;
  athleteAName: string;
  athleteBName: string;
}

export interface SpatialSample {
  progressIndex: number; // 0..1000 (s = progressIndex / 1000)
  normalizedProgress: number;
  distanceMeters: number;
  elapsedTimeSec: number;
  speedKmh: number;
  speedMph: number;
  speedUncertaintyKmh: number;
  provenance: DataProvenance;
  gateNumber: number | null;
  pitchRatio: number;
}

export interface TemporalSample {
  timeIndex: number; // 100 Hz index (t = timeIndex * 0.01)
  elapsedTimeSec: number;
  normalizedProgress: number;
  distanceMeters: number;
  speedKmh: number;
  mapX: number;
  mapY: number;
}

export interface AthleteRunTelemetry {
  athleteId: string;
  athleteName: string;
  bibNumber: number;
  countryCode: string;
  clipUrl: string;
  startClipOffsetSec: number; // Timestamp in MP4 clip when start wand triggers (t = 0)
  totalTimeSec: number;
  nativeFps: number; // e.g., 29.97002997 or 59.94005994
  anchors: CheckpointAnchor[];
  samplesByProgress: SpatialSample[]; // Length = 1001
  samplesByTime: TemporalSample[]; // Length = Math.ceil(totalTimeSec * 100) + 1
}

export interface MicroSectorComparison {
  sectorId: string;
  label: string;
  startProgress: number;
  endProgress: number;
  startGate: number | null;
  endGate: number | null;
  athleteASectorTimeSec: number;
  athleteBSectorTimeSec: number;
  sectorDeltaSec: number; // t_A(s_end) - t_A(s_start) - (t_B(s_end) - t_B(s_start)); negative = Athlete A faster
  cumulativeDeltaEndSec: number; // t_A(s_end) - t_B(s_end); negative = Athlete A ahead
  turnExecutionDeltaSec: number;
  glideCarryDeltaSec: number;
  dominantFactor: 'TURN_EXECUTION' | 'GLIDE_CARRY' | 'BALANCED';
}

export interface CoachingHighlight {
  id: string;
  title: string;
  sectionLabel: string;
  startProgress: number;
  endProgress: number;
  athleteATimestampSec: number;
  athleteBTimestampSec: number;
  timeSwingSec: number;
  turnExecutionDeltaSec: number;
  glideCarryDeltaSec: number;
  entrySpeedDiffKmh: number;
  exitSpeedDiffKmh: number;
  summaryText: string;
  uncertaintyNote: string;
  provenance: DataProvenance;
}

export interface RaceComparisonManifest {
  raceId: string;
  isSyntheticDemo?: boolean;
  provenanceDisclosure?: string;
  courseProfile: CourseProfile;
  athleteA: AthleteRunTelemetry;
  athleteB: AthleteRunTelemetry;
  microSectors: MicroSectorComparison[];
  coachingHighlights: CoachingHighlight[];
}
