import { solveRaceComparisonManifest } from '../../../../src/shared/kinematic-solver.js';
import type { AnchorOverrideRecord } from '../../../../src/shared/types.js';
import { BASE_MANIFESTS, type Env } from '../index.js';

// Fallback in-memory override store when running in local Vite dev without a D1 binding
export const memoryOverridesStore = new Map<string, AnchorOverrideRecord[]>();

export async function loadOverridesForRace(
  env: Env | undefined,
  raceId: string
): Promise<AnchorOverrideRecord[]> {
  if (env?.DB_TELEMETRY) {
    const stmt = env.DB_TELEMETRY.prepare(
      `SELECT race_id as raceId, athlete_id as athleteId, anchor_id as anchorId, video_timestamp_sec as videoTimestampSec, provenance, updated_at as updatedAt
       FROM anchor_overrides
       WHERE race_id = ?`
    ).bind(raceId);
    const { results } = await stmt.all<AnchorOverrideRecord>();
    return results ?? [];
  }
  return memoryOverridesStore.get(raceId) ?? [];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const raceId = String(context.params.raceId ?? '');
  const baseManifest = BASE_MANIFESTS[raceId];

  if (!baseManifest) {
    return new Response(JSON.stringify({ error: `Unknown raceId: ${raceId}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const url = new URL(context.request.url);
  const courseMapParam = url.searchParams.get('courseMap');
  const courseMapEnabled =
    courseMapParam === null
      ? baseManifest.courseProfile.courseMapEnabled
      : courseMapParam !== 'false';

  const overrides = await loadOverridesForRace(context.env, raceId);
  const solved = solveRaceComparisonManifest(baseManifest, overrides, courseMapEnabled);

  return new Response(JSON.stringify(solved), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
