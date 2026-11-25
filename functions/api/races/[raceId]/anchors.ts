import {
  solveRaceComparisonManifest,
  validatePairwiseAnchorMonotonicity,
} from '../../../../src/shared/kinematic-solver.js';
import type {
  AnchorOverrideRecord,
  CheckpointAnchor,
  PutAnchorOverridesRequest,
} from '../../../../src/shared/types.js';
import { BASE_MANIFESTS, type Env } from '../index.js';
import { loadOverridesForRace, memoryOverridesStore } from './manifest.js';

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const raceId = String(context.params.raceId ?? '');
  const baseManifest = BASE_MANIFESTS[raceId];

  if (!baseManifest) {
    return new Response(JSON.stringify({ error: `Unknown raceId: ${raceId}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let body: PutAnchorOverridesRequest;
  try {
    body = (await context.request.json()) as PutAnchorOverridesRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (!body || typeof body.athleteId !== 'string' || !Array.isArray(body.overrides)) {
    return new Response(
      JSON.stringify({ error: 'athleteId and overrides[] are required' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  const targetAthlete =
    body.athleteId === baseManifest.athleteA.athleteId
      ? baseManifest.athleteA
      : body.athleteId === baseManifest.athleteB.athleteId
        ? baseManifest.athleteB
        : null;

  if (!targetAthlete) {
    return new Response(
      JSON.stringify({ error: `Unknown athleteId: ${body.athleteId}` }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  const validAnchorIds = new Set(targetAthlete.anchors.map((a) => a.anchorId));
  for (const item of body.overrides) {
    if (!validAnchorIds.has(item.anchorId)) {
      return new Response(
        JSON.stringify({ error: `Unknown anchorId: ${item.anchorId}` }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }
      );
    }
  }

  // Merge existing D1 overrides + incoming sparse overrides onto baseline anchors
  const existingOverrides = await loadOverridesForRace(context.env, raceId);
  const mergedOverrideMap = new Map<string, AnchorOverrideRecord>();
  for (const ov of existingOverrides) {
    mergedOverrideMap.set(`${ov.athleteId}:${ov.anchorId}`, ov);
  }

  const nowIso = new Date().toISOString();
  const incomingRecords: AnchorOverrideRecord[] = [];
  for (const item of body.overrides) {
    const rec: AnchorOverrideRecord = {
      raceId,
      athleteId: body.athleteId,
      anchorId: item.anchorId,
      videoTimestampSec: Number(item.videoTimestampSec),
      provenance: 'MANUALLY_ANNOTATED',
      updatedAt: nowIso,
    };
    mergedOverrideMap.set(`${rec.athleteId}:${rec.anchorId}`, rec);
    incomingRecords.push(rec);
  }

  const candidateAnchors: CheckpointAnchor[] = targetAthlete.anchors.map((a) => {
    const ov = mergedOverrideMap.get(`${targetAthlete.athleteId}:${a.anchorId}`);
    return ov
      ? {
          ...a,
          videoTimestampSec: ov.videoTimestampSec,
          provenance: 'MANUALLY_ANNOTATED',
        }
      : a;
  });

  const validation = validatePairwiseAnchorMonotonicity(
    candidateAnchors,
    targetAthlete.totalTimeSec
  );
  if (!validation.valid) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (context.env?.DB_TELEMETRY) {
    for (const rec of incomingRecords) {
      await context.env.DB_TELEMETRY.prepare(
        `INSERT INTO anchor_overrides (race_id, athlete_id, anchor_id, video_timestamp_sec, provenance, updated_at)
         VALUES (?, ?, ?, ?, 'MANUALLY_ANNOTATED', ?)
         ON CONFLICT(race_id, athlete_id, anchor_id)
         DO UPDATE SET video_timestamp_sec = excluded.video_timestamp_sec, provenance = 'MANUALLY_ANNOTATED', updated_at = excluded.updated_at`
      )
        .bind(
          rec.raceId,
          rec.athleteId,
          rec.anchorId,
          rec.videoTimestampSec,
          rec.updatedAt ?? nowIso
        )
        .run();
    }
  } else {
    memoryOverridesStore.set(raceId, Array.from(mergedOverrideMap.values()));
  }

  const updatedOverrides = await loadOverridesForRace(context.env, raceId);
  const solved = solveRaceComparisonManifest(baseManifest, updatedOverrides);

  return new Response(JSON.stringify(solved), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const raceId = String(context.params.raceId ?? '');
  const baseManifest = BASE_MANIFESTS[raceId];

  if (!baseManifest) {
    return new Response(JSON.stringify({ error: `Unknown raceId: ${raceId}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (context.env?.DB_TELEMETRY) {
    await context.env.DB_TELEMETRY.prepare(
      `DELETE FROM anchor_overrides WHERE race_id = ?`
    )
      .bind(raceId)
      .run();
  } else {
    memoryOverridesStore.delete(raceId);
  }

  const solved = solveRaceComparisonManifest(baseManifest, []);

  return new Response(JSON.stringify(solved), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
