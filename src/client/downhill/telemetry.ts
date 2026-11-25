import type { VideoLtcSpan } from './decode-video-ltc.js';

const SECONDS_PER_DAY = 86_400;
const SAMPLE_HZ = 10;
const CUE_UNCERTAINTY_SEC = 1 / 25;
const EPSILON = 1e-7;

export type LtcSpan = VideoLtcSpan;

export interface VideoMark {
  clipId: string;
  videoSec: number;
}

export interface CourseAnchor {
  distanceM: number;
  distanceUncertaintyM?: number;
  distanceScaleUncertainty?: number;
  marks: readonly [VideoMark, VideoMark];
}

export interface TimedClip {
  id: string;
  source?: string;
  spans: readonly LtcSpan[];
}

interface AthleteInput {
  name: string;
  clips: readonly TimedClip[];
}

interface RaceInput {
  courseLengthM: number;
  athletes: readonly [AthleteInput, AthleteInput];
  anchors: readonly CourseAnchor[];
}

export interface TelemetryPoint {
  elapsedSec: number;
  utcSec: number;
  distanceM: number;
  speedKmh: number;
  speedUncertaintyKmh: number;
  clipId: string;
  source: string;
  videoSec: number;
}

interface DistanceWindow {
  startDistanceM: number;
  endDistanceM: number;
}

export interface AthleteAnalysis {
  name: string;
  startUtcSec: number;
  durationSec: number;
  coverage: readonly DistanceWindow[];
  atDistance(distanceM: number): TelemetryPoint | null;
  distanceAt(elapsedSec: number): TelemetryPoint | null;
  distanceAtElapsed(elapsedSec: number): number;
  elapsedAtDistance(distanceM: number): number;
}

export interface RaceAnalysis {
  athletes: readonly [AthleteAnalysis, AthleteAnalysis];
  startDistanceM: number;
  endDistanceM: number;
}

interface AnchorPoint {
  distanceM: number;
  distanceUncertaintyM: number;
  distanceScaleUncertainty: number;
  elapsedSec: number;
}

interface Segment {
  start: AnchorPoint;
  end: AnchorPoint;
  speedKmh: number;
  speedUncertaintyKmh: number;
}

interface CameraSpan {
  clipId: string;
  source: string;
  span: LtcSpan;
  clipStartElapsedSec: number;
  startElapsedSec: number;
  endElapsedSec: number;
}

function utcNear(utcSec: number, referenceUtcSec: number): number {
  return utcSec + Math.round((referenceUtcSec - utcSec) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function validSpan(span: LtcSpan): boolean {
  return Number.isFinite(span.startVideoSec)
    && Number.isFinite(span.endVideoSec)
    && Number.isFinite(span.startUtcSec)
    && Number.isFinite(span.endUtcSec)
    && span.startVideoSec >= 0
    && span.endVideoSec > span.startVideoSec
    && utcNear(span.endUtcSec, span.startUtcSec) > span.startUtcSec;
}

export function timeAtVideoPosition(spans: readonly LtcSpan[], videoSec: number): number | null {
  const span = spans.find((candidate) => validSpan(candidate)
    && candidate.startVideoSec <= videoSec && videoSec <= candidate.endVideoSec);
  if (!span) return null;
  const fraction = (videoSec - span.startVideoSec) / (span.endVideoSec - span.startVideoSec);
  return span.startUtcSec + fraction * (utcNear(span.endUtcSec, span.startUtcSec) - span.startUtcSec);
}

function buildSegments(points: readonly AnchorPoint[], athleteName: string): Segment[] {
  return points.slice(1).map((end, index) => {
    const start = points[index];
    const time = end.elapsedSec - start.elapsedSec;
    const uncertaintySec = 2 * CUE_UNCERTAINTY_SEC;
    if (time <= uncertaintySec) {
      throw new Error(`${athleteName}: mark the ${end.distanceM} m point after the preceding point.`);
    }
    const distance = end.distanceM - start.distanceM;
    const scaleUncertainty = distance * Math.max(start.distanceScaleUncertainty, end.distanceScaleUncertainty);
    const distanceUncertainty = start.distanceUncertaintyM + end.distanceUncertaintyM + scaleUncertainty;
    const speedKmh = 3.6 * distance / time;
    const speedUpper = 3.6 * (distance + distanceUncertainty) / (time - uncertaintySec);
    const speedLower = 3.6 * Math.max(0, distance - distanceUncertainty) / (time + uncertaintySec);
    return { start, end, speedKmh, speedUncertaintyKmh: Math.max(speedUpper - speedKmh, speedKmh - speedLower) };
  });
}

function cameraSchedule(clips: readonly TimedClip[], origin: number, durationSec: number): CameraSpan[] {
  const candidates = clips.flatMap(({ id, source, spans }) => spans.filter(validSpan).map((span) => {
    const utcStart = utcNear(span.startUtcSec, origin);
    const utcEnd = utcNear(span.endUtcSec, utcStart);
    const clipStartElapsedSec = utcStart - origin;
    return {
      clipId: id,
      source: source ?? id,
      span,
      clipStartElapsedSec,
      startElapsedSec: Math.max(0, clipStartElapsedSec),
      endElapsedSec: Math.min(durationSec, utcEnd - origin),
    };
  })).filter((camera) => camera.endElapsedSec > camera.startElapsedSec);
  candidates.sort((a, b) => a.startElapsedSec - b.startElapsedSec
    || b.endElapsedSec - a.endElapsedSec || a.clipId.localeCompare(b.clipId));

  const schedule: CameraSpan[] = [];
  let cursor = 0;
  let nextCandidate = 0;
  while (nextCandidate < candidates.length) {
    cursor = Math.max(cursor, candidates[nextCandidate].startElapsedSec);
    let chosen = candidates[nextCandidate++];
    while (nextCandidate < candidates.length && candidates[nextCandidate].startElapsedSec <= cursor + EPSILON) {
      const candidate = candidates[nextCandidate++];
      if (candidate.endElapsedSec > chosen.endElapsedSec) chosen = candidate;
    }
    if (chosen.endElapsedSec > cursor) {
      schedule.push({ ...chosen, startElapsedSec: Math.max(cursor, chosen.startElapsedSec) });
      cursor = chosen.endElapsedSec;
    }
  }
  return schedule;
}

function mergeCoverage(schedule: readonly CameraSpan[], distanceAtElapsed: (elapsedSec: number) => number): DistanceWindow[] {
  const coverage: DistanceWindow[] = [];
  for (const camera of schedule) {
    const startDistanceM = distanceAtElapsed(camera.startElapsedSec);
    const endDistanceM = distanceAtElapsed(camera.endElapsedSec);
    const previous = coverage.at(-1);
    if (previous && startDistanceM - previous.endDistanceM <= EPSILON) {
      previous.endDistanceM = endDistanceM;
    } else {
      coverage.push({ startDistanceM, endDistanceM });
    }
  }
  return coverage;
}

function estimateAthlete(athlete: AthleteInput, anchors: readonly CourseAnchor[], racer: 0 | 1, courseLengthM: number): AthleteAnalysis {
  const { name, clips } = athlete;
  const spanByClipId = new Map(clips.map((clip) => [clip.id, clip.spans]));
  if (spanByClipId.size !== clips.length) throw new Error(`${name}: duplicate clip identifier.`);

  const times = anchors.map((anchor) => {
    const mark = anchor.marks[racer];
    const utcSec = timeAtVideoPosition(spanByClipId.get(mark.clipId) ?? [], mark.videoSec);
    if (utcSec === null) throw new Error(`${name}: the ${anchor.distanceM} m mark needs decoded timecode.`);
    return utcSec;
  });
  const startUtcSec = times[0];
  const points = anchors.map((anchor, index) => ({
    distanceM: anchor.distanceM,
    distanceUncertaintyM: anchor.distanceUncertaintyM
      ?? (anchor.distanceM === 0 || anchor.distanceM === courseLengthM ? 0 : 0.05 * courseLengthM),
    distanceScaleUncertainty: anchor.distanceScaleUncertainty ?? 0,
    elapsedSec: utcNear(times[index], startUtcSec) - startUtcSec,
  }));
  const segments = buildSegments(points, name);
  const last = points[points.length - 1];
  const durationSec = last.elapsedSec;
  const schedule = cameraSchedule(clips, startUtcSec, durationSec);

  function segmentAtElapsed(elapsedSec: number): Segment {
    return segments.find((segment) => elapsedSec < segment.end.elapsedSec) ?? segments[segments.length - 1];
  }

  function distanceAtElapsed(elapsedSec: number): number {
    const time = Math.max(0, Math.min(elapsedSec, durationSec));
    const { start, speedKmh } = segmentAtElapsed(time);
    return start.distanceM + (time - start.elapsedSec) * speedKmh / 3.6;
  }

  function elapsedAtDistance(distanceM: number): number {
    const distance = Math.max(0, Math.min(distanceM, last.distanceM));
    const { start, speedKmh } = segments.find((segment) => distance < segment.end.distanceM)
      ?? segments[segments.length - 1];
    return start.elapsedSec + 3.6 * (distance - start.distanceM) / speedKmh;
  }

  function distanceAt(elapsedSec: number): TelemetryPoint | null {
    if (!Number.isFinite(elapsedSec) || elapsedSec < -EPSILON || elapsedSec > durationSec + EPSILON) return null;
    const time = Math.max(0, Math.min(elapsedSec, durationSec));
    const camera = schedule.find((span) => span.startElapsedSec <= time + EPSILON && span.endElapsedSec >= time - EPSILON);
    if (!camera) return null;
    const { span, clipId, source, clipStartElapsedSec } = camera;
    const clockDuration = utcNear(span.endUtcSec, span.startUtcSec) - span.startUtcSec;
    const fraction = Math.min(1, Math.max(0, (time - clipStartElapsedSec) / clockDuration));
    const videoSec = span.startVideoSec + fraction * (span.endVideoSec - span.startVideoSec);
    const segment = segmentAtElapsed(time);
    return {
      elapsedSec: time,
      utcSec: startUtcSec + time,
      distanceM: distanceAtElapsed(time),
      speedKmh: segment.speedKmh,
      speedUncertaintyKmh: segment.speedUncertaintyKmh,
      clipId,
      source,
      videoSec,
    };
  }

  return {
    name, startUtcSec, durationSec,
    coverage: mergeCoverage(schedule, distanceAtElapsed),
    atDistance: (distanceM) => Number.isFinite(distanceM) && distanceM >= -EPSILON && distanceM <= last.distanceM + EPSILON
      ? distanceAt(elapsedAtDistance(distanceM))
      : null,
    distanceAt, distanceAtElapsed, elapsedAtDistance,
  };
}

export function estimateRace({ courseLengthM, athletes, anchors }: RaceInput): RaceAnalysis {
  if (!Number.isFinite(courseLengthM) || courseLengthM <= 0) throw new Error('Enter a positive course length.');
  const [first, second] = athletes.map((athlete) => athlete.name.trim().toLowerCase());
  if (!first || !second || first === second) throw new Error('Enter two different athlete names.');
  const ordered = [...anchors].sort((a, b) => a.distanceM - b.distanceM);
  if (ordered.length < 2 || ordered[0].distanceM !== 0) {
    throw new Error('Mark the start at 0 m and another shared landmark.');
  }
  if (ordered.some(({ distanceM, distanceUncertaintyM, distanceScaleUncertainty }, index) => !Number.isFinite(distanceM)
    || distanceM > courseLengthM || (index > 0 && distanceM <= ordered[index - 1].distanceM)
    || (distanceUncertaintyM !== undefined && (!Number.isFinite(distanceUncertaintyM) || distanceUncertaintyM < 0))
    || (distanceScaleUncertainty !== undefined && (!Number.isFinite(distanceScaleUncertainty) || distanceScaleUncertainty < 0)))) {
    throw new Error('Each mark needs a unique distance on the course and a non-negative uncertainty.');
  }
  return {
    athletes: [estimateAthlete(athletes[0], ordered, 0, courseLengthM), estimateAthlete(athletes[1], ordered, 1, courseLengthM)],
    startDistanceM: 0,
    endDistanceM: ordered[ordered.length - 1].distanceM,
  };
}

export function formatUtc(utcSec: number): string {
  const dayMs = SECONDS_PER_DAY * 1_000;
  const totalMs = ((Math.round(utcSec * 1_000) % dayMs) + dayMs) % dayMs;
  return new Date(totalMs).toISOString().slice(11, 23);
}

function csvText(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function toTelemetryCsv(analysis: AthleteAnalysis): string {
  const rows = ['athlete,time_utc,run_elapsed_s,distance_m,speed_kmh,estimate_uncertainty_kmh,provenance,source_clip,video_s'];
  const name = csvText(analysis.name);
  const endTick = Math.floor(analysis.durationSec * SAMPLE_HZ + EPSILON);
  for (let tick = 0; tick <= endTick; tick += 1) {
    const sample = analysis.distanceAt(tick / SAMPLE_HZ);
    if (!sample) continue;
    rows.push([
      name, formatUtc(sample.utcSec), sample.elapsedSec.toFixed(3), sample.distanceM.toFixed(3),
      sample.speedKmh.toFixed(3), sample.speedUncertaintyKmh.toFixed(3), 'estimated_segment_average_from_video_ltc',
      csvText(sample.source), sample.videoSec.toFixed(4),
    ].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
