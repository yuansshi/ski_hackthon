import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onRequestGet as getRaces, type Env } from '../functions/api/races/index.js';
import { onRequestGet as getManifest } from '../functions/api/races/[raceId]/manifest.js';
import {
  onRequestDelete as deleteAnchors,
  onRequestPut as putAnchors,
} from '../functions/api/races/[raceId]/anchors.js';
import {
  onRequestGet as getClip,
  parseByteRangeHeader,
} from '../functions/api/clips/[clipKey].js';
import type {
  AnchorOverrideRecord,
  RaceCatalogItem,
  RaceComparisonManifest,
} from '../src/shared/types.js';

function createMockEnv(): Env {
  const rows = new Map<string, AnchorOverrideRecord>();
  const sgClipPath = path.resolve(process.cwd(), 'public/clips/sg-athlete-a.mp4');
  const clipBytes = fs.existsSync(sgClipPath)
    ? new Uint8Array(fs.readFileSync(sgClipPath))
    : new Uint8Array(4096).fill(0x42);

  const mockD1 = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              const raceId = String(args[0]);
              const list = Array.from(rows.values()).filter((r) => r.raceId === raceId);
              return { results: list as unknown as T[] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO anchor_overrides')) {
                const [raceId, athleteId, anchorId, videoTimestampSec, updatedAt] = args as [
                  string,
                  string,
                  string,
                  number,
                  string,
                ];
                rows.set(`${raceId}:${athleteId}:${anchorId}`, {
                  raceId,
                  athleteId,
                  anchorId,
                  videoTimestampSec,
                  provenance: 'MANUALLY_ANNOTATED',
                  updatedAt,
                });
              } else if (sql.startsWith('DELETE FROM anchor_overrides')) {
                const raceId = String(args[0]);
                for (const key of rows.keys()) {
                  if (key.startsWith(`${raceId}:`)) {
                    rows.delete(key);
                  }
                }
              }
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  const mockR2 = {
    async head(key: string) {
      if (key !== 'sg-athlete-a.mp4') return null;
      return {
        size: clipBytes.byteLength,
        httpEtag: '"etag-sg-a"',
      };
    },
    async get(
      key: string,
      options?: { range?: { offset: number; length: number } }
    ) {
      if (key !== 'sg-athlete-a.mp4') return null;
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? clipBytes.byteLength;
      const slice = clipBytes.slice(offset, offset + length);
      return {
        size: clipBytes.byteLength,
        httpEtag: '"etag-sg-a"',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      };
    },
  } as unknown as R2Bucket;

  return {
    DB_TELEMETRY: mockD1,
    R2_CLIPS: mockR2,
  };
}

function makeContext(
  request: Request,
  params: Record<string, string>,
  env: Env
): EventContext<Env, string, Record<string, unknown>> {
  return {
    request,
    params,
    env,
    functionPath: '',
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(),
    data: {},
  } as unknown as EventContext<Env, string, Record<string, unknown>>;
}

describe('Cloudflare Edge API & Monotonic Anchor Validation (api.test.ts)', () => {
  it('serves race catalog and toggles courseMap on GET /api/races/:raceId/manifest', async () => {
    const env = createMockEnv();
    const listResp = await getRaces(
      makeContext(new Request('http://localhost/api/races'), {}, env)
    );
    expect(listResp.status).toBe(200);
    const catalog = (await listResp.json()) as RaceCatalogItem[];
    expect(catalog).toHaveLength(2);
    expect(catalog[0].raceId).toBe('beaver-creek-men-sg-2025');

    const sgOnResp = await getManifest(
      makeContext(
        new Request(
          'http://localhost/api/races/beaver-creek-men-sg-2025/manifest?courseMap=true'
        ),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    expect(sgOnResp.status).toBe(200);
    const sgOn = (await sgOnResp.json()) as RaceComparisonManifest;
    expect(sgOn.courseProfile.courseMapEnabled).toBe(true);

    const sgOffResp = await getManifest(
      makeContext(
        new Request(
          'http://localhost/api/races/beaver-creek-men-sg-2025/manifest?courseMap=false'
        ),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    const sgOff = (await sgOffResp.json()) as RaceComparisonManifest;
    expect(sgOff.courseProfile.courseMapEnabled).toBe(false);

    const notFoundResp = await getManifest(
      makeContext(
        new Request('http://localhost/api/races/unknown/manifest'),
        { raceId: 'unknown' },
        env
      )
    );
    expect(notFoundResp.status).toBe(404);
  });

  it('persists valid sparse anchor overrides, preserves untouched provenance, rejects non-monotonic timestamps with HTTP 400, and resets on DELETE', async () => {
    const env = createMockEnv();
    const baseResp = await getManifest(
      makeContext(
        new Request('http://localhost/api/races/beaver-creek-men-sg-2025/manifest'),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    const base = (await baseResp.json()) as RaceComparisonManifest;
    const gate12 = base.athleteB.anchors.find((a) => a.anchorId === 'gate-12')!;
    const nudgedTime = Number((gate12.videoTimestampSec + 0.067).toFixed(4));

    // Valid +2 frame (+0.067s) nudge on Gate 12
    const putResp = await putAnchors(
      makeContext(
        new Request('http://localhost/api/races/beaver-creek-men-sg-2025/anchors', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            athleteId: 'cochran-siegle-sg',
            overrides: [{ anchorId: 'gate-12', videoTimestampSec: nudgedTime }],
          }),
        }),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    expect(putResp.status).toBe(200);
    const updated = (await putResp.json()) as RaceComparisonManifest;
    const updatedGate12 = updated.athleteB.anchors.find((a) => a.anchorId === 'gate-12')!;
    expect(updatedGate12.videoTimestampSec).toBe(nudgedTime);
    expect(updatedGate12.provenance).toBe('MANUALLY_ANNOTATED');

    // Untouched Gate 11 retains its simulated baseline provenance.
    const untouchedGate11 = updated.athleteB.anchors.find((a) => a.anchorId === 'gate-11')!;
    expect(untouchedGate11.provenance).toBe('SIMULATED');

    // Reject non-monotonic timestamp (setting Gate 12 earlier than Gate 11) with HTTP 400
    const badPutResp = await putAnchors(
      makeContext(
        new Request('http://localhost/api/races/beaver-creek-men-sg-2025/anchors', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            athleteId: 'cochran-siegle-sg',
            overrides: [
              {
                anchorId: 'gate-12',
                videoTimestampSec: untouchedGate11.videoTimestampSec - 0.5,
              },
            ],
          }),
        }),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    expect(badPutResp.status).toBe(400);

    // Reset via DELETE /api/races/:raceId/anchors
    const delResp = await deleteAnchors(
      makeContext(
        new Request('http://localhost/api/races/beaver-creek-men-sg-2025/anchors', {
          method: 'DELETE',
        }),
        { raceId: 'beaver-creek-men-sg-2025' },
        env
      )
    );
    expect(delResp.status).toBe(200);
    const resetManifest = (await delResp.json()) as RaceComparisonManifest;
    const resetGate12 = resetManifest.athleteB.anchors.find(
      (a) => a.anchorId === 'gate-12'
    )!;
    expect(resetGate12.videoTimestampSec).toBe(gate12.videoTimestampSec);
    expect(resetGate12.provenance).toBe('KINEMATIC_INTERPOLATED');
  });

  it('streams HTTP 206 Partial Content byte-ranges on GET /api/clips/:clipKey and rejects invalid ranges with 416', async () => {
    const env = createMockEnv();
    const rangeResp = await getClip(
      makeContext(
        new Request('http://localhost/api/clips/sg-athlete-a.mp4', {
          headers: { Range: 'bytes=0-1023' },
        }),
        { clipKey: 'sg-athlete-a.mp4' },
        env
      )
    );

    expect(rangeResp.status).toBe(206);
    expect(rangeResp.headers.get('Accept-Ranges')).toBe('bytes');
    expect(rangeResp.headers.get('Content-Range')).toMatch(/^bytes 0-1023\/\d+$/);
    expect(rangeResp.headers.get('Content-Length')).toBe('1024');
    const buf = await rangeResp.arrayBuffer();
    expect(buf.byteLength).toBe(1024);

    // Invalid range returns 416
    const badRangeResp = await getClip(
      makeContext(
        new Request('http://localhost/api/clips/sg-athlete-a.mp4', {
          headers: { Range: 'bytes=99999999-100000000' },
        }),
        { clipKey: 'sg-athlete-a.mp4' },
        env
      )
    );
    expect(badRangeResp.status).toBe(416);
    expect(parseByteRangeHeader('invalid', 1000).valid).toBe(false);
  });
});
