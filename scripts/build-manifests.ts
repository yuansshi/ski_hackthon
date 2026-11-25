import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDownhillCourseProfile,
  buildSuperGCourseProfile,
} from '../src/shared/course-geometry.js';
import { solveRaceComparisonManifest } from '../src/shared/kinematic-solver.js';
import type { RaceComparisonManifest } from '../src/shared/types.js';
import { ensureAllClips } from './download-and-clip.js';
import {
  buildRealGpsCourseProfileOverlay,
  extractOrLoadBaselineAnchors,
} from './extract-anchors.js';
import { RAW_SUPERG_38_ROWS } from './parse-superg-course.js';

export function buildAllRaceManifests(outputDir?: string): {
  superG: RaceComparisonManifest;
  downhill: RaceComparisonManifest;
} {
  const sgCourse = buildSuperGCourseProfile(RAW_SUPERG_38_ROWS, true);
  const sgAnchors = extractOrLoadBaselineAnchors(sgCourse.raceId, sgCourse);

  const sgSeed: RaceComparisonManifest = {
    raceId: sgCourse.raceId,
    isSyntheticDemo: sgAnchors.isSyntheticDemo,
    provenanceDisclosure: sgAnchors.provenanceDisclosure,
    courseProfile: sgCourse,
    athleteA: {
      ...sgAnchors.athleteA,
      samplesByProgress: [],
      samplesByTime: [],
    },
    athleteB: {
      ...sgAnchors.athleteB,
      samplesByProgress: [],
      samplesByTime: [],
    },
    microSectors: [],
    coachingHighlights: [],
  };

  const superG = solveRaceComparisonManifest(sgSeed, [], true);

  const baseDownhillCourse = buildDownhillCourseProfile();
  const dhAnchors = extractOrLoadBaselineAnchors(baseDownhillCourse.raceId, baseDownhillCourse);
  const dhCourse = dhAnchors.isSyntheticDemo
    ? baseDownhillCourse
    : buildRealGpsCourseProfileOverlay(baseDownhillCourse);

  const dhSeed: RaceComparisonManifest = {
    raceId: dhCourse.raceId,
    isSyntheticDemo: dhAnchors.isSyntheticDemo,
    provenanceDisclosure: dhAnchors.provenanceDisclosure,
    courseProfile: dhCourse,
    athleteA: {
      ...dhAnchors.athleteA,
      samplesByProgress: [],
      samplesByTime: [],
    },
    athleteB: {
      ...dhAnchors.athleteB,
      samplesByProgress: [],
      samplesByTime: [],
    },
    microSectors: [],
    coachingHighlights: [],
  };

  const downhill = solveRaceComparisonManifest(dhSeed, [], false);

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    // Compact serialization keeps each manifest well under the 250 KB gzipped NFR budget
    fs.writeFileSync(
      path.join(outputDir, 'beaver-creek-men-sg-2025.json'),
      JSON.stringify(superG) + '\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(outputDir, 'beaver-creek-men-dh-2025.json'),
      JSON.stringify(downhill) + '\n',
      'utf-8'
    );
  }

  return { superG, downhill };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const outDir = path.resolve(process.cwd(), 'public/data');
  await ensureAllClips();
  const { superG, downhill } = buildAllRaceManifests(outDir);
  console.log(
    `[build-manifests] Wrote Super-G (${superG.athleteA.samplesByProgress.length} spatial ticks, ${superG.coachingHighlights.length} highlights) and Downhill (${downhill.athleteA.samplesByProgress.length} spatial ticks, ${downhill.coachingHighlights.length} highlights)`
  );
}
