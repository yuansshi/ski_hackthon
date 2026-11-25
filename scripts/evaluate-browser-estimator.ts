import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import annotations from '../artifacts/downhill-annotations.json';
import timecode from '../artifacts/downhill-ltc.json';
import { inferCourseAnchors } from '../src/client/downhill/calibration.js';
import {
  estimateRace, timeAtVideoPosition, toTelemetryCsv,
  type LtcSpan, type TimedClip, type VideoMark,
} from '../src/client/downhill/telemetry.js';

type VideoRun = (typeof annotations.runs)[number];
type VideoCue = VideoRun['start'];

const course = {
  lengthM: annotations.course.length_m,
  startAltitudeM: annotations.course.start_altitude_m,
  finishAltitudeM: annotations.course.finish_altitude_m,
};
const validationRacers = [
  { name: 'Bryce Bennett', gpsFilePrefix: 'BryceBennett' },
  { name: 'Aleksander Aamodt Kilde', gpsFilePrefix: 'AleksanderAamodt Kilde' },
  { name: 'Erik Arvidsson', gpsFilePrefix: 'ErikArvidsson' },
];
const referenceRacer = 'Ryan Cochran-Siegle';
const rawTimecode = new Map(timecode.clips.map((clip) => [clip.source, clip]));

function runFor(name: string): VideoRun {
  const run = annotations.runs.find((candidate) => candidate.athlete === name);
  if (!run) throw new Error(`Missing video annotations for ${name}.`);
  return run;
}

function prepareRun(run: VideoRun) {
  const spansBySource = new Map<string, LtcSpan[]>();
  for (const clip of run.clips) {
    const source = rawTimecode.get(clip.source);
    if (source?.status !== 'decoded') throw new Error(`Missing decoded LTC for ${clip.source}.`);
    const spans = spansBySource.get(clip.source) ?? [];
    for (const rawSpan of source.spans) {
      const span = {
        startVideoSec: rawSpan.start_video_s,
        endVideoSec: rawSpan.end_video_s,
        startUtcSec: rawSpan.start_utc_s,
        endUtcSec: rawSpan.end_utc_s,
      };
      const startVideoSec = Math.max(span.startVideoSec, clip.visible_start_s);
      const endVideoSec = Math.min(span.endVideoSec, clip.visible_end_s);
      const startUtcSec = timeAtVideoPosition([span], startVideoSec);
      const endUtcSec = timeAtVideoPosition([span], endVideoSec);
      if (endVideoSec > startVideoSec && startUtcSec !== null && endUtcSec !== null) {
        spans.push({ startVideoSec, endVideoSec, startUtcSec, endUtcSec });
      }
    }
    spansBySource.set(clip.source, spans);
  }
  const clips = Array.from(spansBySource, ([source, spans]): TimedClip => ({ id: source, source, spans }));
  return { name: run.athlete, clips };
}

function sharedCue(
  name: string, distanceM: number | null, a: VideoCue, b: VideoCue,
  athletes: readonly [ReturnType<typeof prepareRun>, ReturnType<typeof prepareRun>],
) {
  const marks: [VideoMark, VideoMark] = [
    { clipId: a.source, videoSec: a.video_s },
    { clipId: b.source, videoSec: b.video_s },
  ];
  function markUtc(lane: 0 | 1): number {
    const mark = marks[lane];
    const clip = athletes[lane].clips.find((candidate) => candidate.id === mark.clipId);
    const utc = timeAtVideoPosition(clip?.spans ?? [], mark.videoSec);
    if (utc === null) throw new Error(`${athletes[lane].name} has no decoded LTC at ${name}.`);
    return utc;
  }
  const times: [number, number] = [markUtc(0), markUtc(1)];
  return { name, distanceM, marks, times };
}

function browserExportSamples(csv: string) {
  const [, ...rows] = csv.trimEnd().split('\r\n');
  return rows.map((row) => {
    const match = row.match(/^"(?:[^"]|"")*",(\d{2}):(\d{2}):(\d{2}\.\d{3}),([\d.]+),([\d.]+),([\d.]+),/);
    if (!match) throw new Error('Unexpected browser telemetry CSV row.');
    const [, hours, minutes, seconds, elapsed, distance, speed] = match;
    return {
      utc_s: Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds),
      run_elapsed_s: Number(elapsed),
      distance_m: Number(distance),
      speed_kmh: Number(speed),
    };
  });
}

function estimateHoldout(reference: VideoRun, holdout: VideoRun) {
  const athletes: [ReturnType<typeof prepareRun>, ReturnType<typeof prepareRun>] = [prepareRun(reference), prepareRun(holdout)];
  const start = sharedCue('start', 0, reference.start, holdout.start, athletes);
  const marks = reference.landmarks.map((landmark) => {
    const matching = holdout.landmarks.find((candidate) => candidate.name === landmark.name);
    if (!matching) throw new Error(`No ${landmark.name} cue for ${holdout.athlete}.`);
    return sharedCue(landmark.name, null, landmark, matching, athletes);
  });
  const anchors = inferCourseAnchors(course, start, marks);
  const result = estimateRace({ courseLengthM: course.lengthM, athletes, anchors });
  const [, athlete] = result.athletes;
  return {
    athlete: athlete.name,
    start_utc_s: athlete.startUtcSec,
    total_elapsed_s: athlete.durationSec,
    finish_kind: 'unobserved',
    samples: browserExportSamples(toTelemetryCsv(athlete)),
    coverage: {
      elapsed_through_last_landmark_s: Number(athlete.durationSec.toFixed(3)),
      estimated_last_landmark_distance_m: Number(result.endDistanceM.toFixed(2)),
      covered_distance_intervals: athlete.coverage.length,
    },
  };
}

const { values } = parseArgs({ options: {
  'gps-dir': { type: 'string', default: 'Beaver Creek Downhill GPS Data' },
  output: { type: 'string', default: 'public/comparison/browser-holdout.json' },
} });
const reference = runFor(referenceRacer);
const runs = validationRacers.map(({ name }) => estimateHoldout(reference, runFor(name)));
const estimate = JSON.stringify({ training_athletes: [], runs });
const temp = mkdtempSync(join(tmpdir(), 'ski-browser-holdout-'));
const stagedReport = join(dirname(values.output), `.${basename(temp)}.tmp`);

try {
  const estimatePath = join(temp, 'estimates.json');
  const reportPath = join(temp, 'report.json');
  writeFileSync(estimatePath, estimate);

  const gpsPaths = validationRacers.map(({ gpsFilePrefix }) =>
    join(values['gps-dir'], `${gpsFilePrefix}-Beaver Creek_251203_DH-Tr.2-2025-12-03-Runs.csv`));
  execFileSync('python3', ['scripts/estimate-downhill-telemetry.py', 'validate', estimatePath,
    ...gpsPaths, '--output', reportPath], { stdio: 'inherit' });
  const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!report || typeof report !== 'object' || !('holdout' in report) || !Array.isArray(report.holdout)) {
    throw new Error('GPS validator returned an invalid report.');
  }
  if (report.holdout.length !== runs.length) throw new Error('GPS validator did not score every athlete.');
  const holdout = report.holdout.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('athlete' in item) || !('elapsed_duration_error_s' in item)) {
      throw new Error('Invalid estimate score.');
    }
    const run = runs.find((candidate) => candidate.athlete === item.athlete);
    if (!run) throw new Error(`Unexpected athlete in GPS report ${item.athlete}.`);
    const { elapsed_duration_error_s, ...fields } = item;
    return { ...fields, coverage: run.coverage };
  });
  const output = {
    estimator: 'browser_video_only',
    reference_athlete: referenceRacer,
    training_athletes: [],
    sample_rate_hz: 10,
    shared_landmarks: reference.landmarks.length,
    estimates_sha256: createHash('sha256').update(estimate).digest('hex'),
    notes: [
      'The browser estimates speed and distance from course dimensions, decoded audio timecode, and manually matched video landmarks. All interior distances were left blank.',
      'This evaluation replays archival LTC decoded from the real source audio. It scores the same estimation and CSV export functions the browser uses.',
      'The sample has no verified finish cue. Estimates stop at the STIFEL arch. Rows outside annotated timecode coverage are absent.',
      'Elapsed alignment uses each source’s reported start. Raw UTC alignment preserves the disagreement between the camera and GPS clock starts.',
    ],
    holdout,
  };
  writeFileSync(stagedReport, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  renameSync(stagedReport, values.output);
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(stagedReport, { force: true });
}
