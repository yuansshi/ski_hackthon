import sgManifestJson from '../../../public/data/beaver-creek-men-sg-2025.json';
import dhManifestJson from '../../../public/data/beaver-creek-men-dh-2025.json';
import type { RaceCatalogItem, RaceComparisonManifest } from '../../../src/shared/types.js';

export interface Env {
  DB_TELEMETRY?: D1Database;
  R2_CLIPS?: R2Bucket;
  ASSETS?: Fetcher;
}

const sgManifest = sgManifestJson as unknown as RaceComparisonManifest;
const dhManifest = dhManifestJson as unknown as RaceComparisonManifest;

export const BASE_MANIFESTS: Record<string, RaceComparisonManifest> = {
  [sgManifest.raceId]: sgManifest,
  [dhManifest.raceId]: dhManifest,
};

export const onRequestGet: PagesFunction<Env> = async () => {
  const catalog: RaceCatalogItem[] = Object.values(BASE_MANIFESTS).map((m) => ({
    raceId: m.raceId,
    discipline: m.courseProfile.discipline,
    title: m.courseProfile.title,
    hasGpsCourseMap: m.courseProfile.hasGpsCourseMap,
    athleteAName: `${m.athleteA.athleteName} (${m.athleteA.countryCode} #${m.athleteA.bibNumber})`,
    athleteBName: `${m.athleteB.athleteName} (${m.athleteB.countryCode} #${m.athleteB.bibNumber})`,
  }));

  return new Response(JSON.stringify(catalog), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
