import type { CourseAnchor, VideoMark } from './telemetry.js';

interface CourseFacts {
  lengthM: number;
  startAltitudeM: number;
  finishAltitudeM: number;
}

interface TimedMark {
  name: string;
  distanceM: number | null;
  times: readonly [number, number];
  marks: readonly [VideoMark, VideoMark];
}

const SECONDS_PER_DAY = 86_400;

function elapsedAfterStart(utcSec: number, startUtcSec: number): number {
  const seconds = utcSec - startUtcSec;
  return seconds - Math.round(seconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function travelModel(course: CourseFacts) {
  const grade = (course.startAltitudeM - course.finishAltitudeM) / course.lengthM;
  const netAcceleration = Math.max(0.6, 9.81 * grade - 0.26);
  const topSpeed = Math.max(18, Math.min(37, Math.sqrt(netAcceleration / 0.0024)));
  const initialSpeed = 4;
  const accelerationTime = topSpeed / netAcceleration;
  return (elapsedSec: number) => topSpeed * elapsedSec
    - (topSpeed - initialSpeed) * accelerationTime * -Math.expm1(-elapsedSec / accelerationTime);
}

export function inferCourseAnchors(course: CourseFacts, start: TimedMark, marks: readonly TimedMark[]) {
  const chronological = [start, ...marks].map((mark) => {
    const a = elapsedAfterStart(mark.times[0], start.times[0]);
    const b = elapsedAfterStart(mark.times[1], start.times[1]);
    return { ...mark, a, b, elapsed: (a + b) / 2 };
  }).sort((first, second) => first.elapsed - second.elapsed);
  if (chronological[0].name !== start.name || chronological[0].distanceM !== 0) {
    throw new Error('Mark the start before every other point.');
  }
  for (let index = 1; index < chronological.length; index++) {
    const last = chronological[index - 1];
    const current = chronological[index];
    if (current.a <= last.a || current.b <= last.b) throw new Error(`Check the order of the ${current.name} marks.`);
  }

  const observed = chronological.filter((mark) => mark.distanceM !== null);
  const last = chronological[chronological.length - 1];
  const travel = travelModel(course);
  const provisionalDistances = chronological.map((mark, index): CourseAnchor => {
    if (mark.distanceM !== null) {
      const atBoundary = mark.distanceM === 0 || mark.distanceM === course.lengthM;
      return {
        distanceM: mark.distanceM,
        distanceUncertaintyM: atBoundary ? 1 : Math.max(5, mark.distanceM * 0.03),
        marks: mark.marks,
      };
    }

    const nextIndex = observed.findIndex((candidate) => candidate.elapsed > mark.elapsed);
    const right = nextIndex === -1 ? undefined : observed[nextIndex];
    const left = nextIndex === -1 ? observed.at(-1) : observed[nextIndex - 1];
    const leftDistance = left?.distanceM ?? 0;
    const leftElapsed = left?.elapsed ?? 0;
    if (right && right.distanceM !== null) {
      const fraction = (mark.elapsed - leftElapsed) / (right.elapsed - leftElapsed);
      const width = right.distanceM - leftDistance;
      return {
        distanceM: leftDistance + fraction * width,
        distanceUncertaintyM: 5,
        distanceScaleUncertainty: 0.15,
        marks: mark.marks,
      };
    }

    const remainingDistance = course.lengthM - leftDistance;
    const modeled = travel(mark.elapsed) - travel(leftElapsed);
    const modeledTotal = travel(last.elapsed) - travel(leftElapsed);
    const scale = Math.min(1, 0.98 * remainingDistance / modeledTotal);
    const distanceM = leftDistance + modeled * scale;
    if (!(distanceM > leftDistance && distanceM < course.lengthM)) {
      throw new Error(`Check the distance or timing of landmark ${index}.`);
    }
    return {
      distanceM,
      distanceUncertaintyM: 5,
      distanceScaleUncertainty: 0.25,
      marks: mark.marks,
    };
  });

  if (provisionalDistances.some((anchor, index) => index > 0
    && anchor.distanceM <= provisionalDistances[index - 1].distanceM)) {
    throw new Error('Landmark distances must increase in the order both racers pass them.');
  }
  return provisionalDistances;
}
