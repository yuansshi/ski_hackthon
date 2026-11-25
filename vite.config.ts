import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { solveRaceComparisonManifest } from './src/shared/kinematic-solver.js';
import type { AnchorOverrideRecord, RaceCatalogItem, RaceComparisonManifest } from './src/shared/types.js';

function createApiDevMiddlewarePlugin(): Plugin {
  const localOverrides = new Map<string, AnchorOverrideRecord[]>();
  const raceIds = ['beaver-creek-men-dh-2025', 'beaver-creek-men-sg-2025'];

  const getManifest = (raceId: string, courseMap = true) => {
    if (!raceIds.includes(raceId)) return null;
    const filename = `${raceId}.json`;
    const filePath = path.resolve(process.cwd(), 'public/data', filename);
    if (!fs.existsSync(filePath)) return null;
    const base = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RaceComparisonManifest;
    const overrides = localOverrides.get(raceId) ?? [];
    return solveRaceComparisonManifest(base, overrides, courseMap);
  };

  const handleApiRequest = async (req: any, res: any, next: any) => {
    const urlStr = req.url || '';
    if (!urlStr.startsWith('/api')) return next();

    const url = new URL(urlStr, 'http://localhost');
    const pathname = url.pathname;

    // 1. GET /api/races
    if (pathname === '/api/races' && req.method === 'GET') {
      const catalog: RaceCatalogItem[] = [];
      for (const raceId of raceIds) {
        const manifest = getManifest(raceId);
        if (!manifest) continue;
        catalog.push({
          raceId,
          discipline: manifest.courseProfile.discipline,
          title: manifest.courseProfile.title,
          hasGpsCourseMap: manifest.courseProfile.hasGpsCourseMap,
          athleteAName: manifest.athleteA.athleteName,
          athleteBName: manifest.athleteB.athleteName,
        });
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(catalog));
      return;
    }

    // 2. GET /api/races/:raceId/manifest
    const manifestMatch = /^\/api\/races\/([^\/]+)\/manifest$/.exec(pathname);
    if (manifestMatch && req.method === 'GET') {
      const raceId = manifestMatch[1];
      const courseMap = url.searchParams.get('courseMap') !== 'false';
      const manifest = getManifest(raceId, courseMap);
      if (!manifest) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `Unknown raceId: ${raceId}` }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifest));
      return;
    }

    // 3. PUT / DELETE /api/races/:raceId/anchors
    const anchorsMatch = /^\/api\/races\/([^\/]+)\/anchors$/.exec(pathname);
    if (anchorsMatch) {
      const raceId = anchorsMatch[1];

      if (req.method === 'DELETE') {
        localOverrides.delete(raceId);
        const resetManifest = getManifest(raceId, true);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(resetManifest));
        return;
      }

      if (req.method === 'PUT') {
        let rawBody = '';
        req.on('data', (chunk: any) => (rawBody += chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(rawBody);
            const existing = localOverrides.get(raceId) ?? [];
            const updated = [...existing];
            for (const ov of body.overrides) {
              const idx = updated.findIndex(
                (o) => o.athleteId === body.athleteId && o.anchorId === ov.anchorId
              );
              const rec: AnchorOverrideRecord = {
                raceId,
                athleteId: body.athleteId,
                anchorId: ov.anchorId,
                videoTimestampSec: Number(ov.videoTimestampSec),
                provenance: 'MANUALLY_ANNOTATED',
                updatedAt: new Date().toISOString(),
              };
              if (idx >= 0) {
                updated[idx] = rec;
              } else {
                updated.push(rec);
              }
            }
            localOverrides.set(raceId, updated);
            const solved = getManifest(raceId, true);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(solved));
          } catch (err: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
    }

    // 4. GET /api/clips/:clipKey
    const clipMatch = /^\/api\/clips\/([^\/]+)$/.exec(pathname);
    if (clipMatch && req.method === 'GET') {
      const clipKey = clipMatch[1];
      const clipPath = path.resolve(process.cwd(), 'public/clips', clipKey);
      if (!fs.existsSync(clipPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `Clip not found: ${clipKey}` }));
        return;
      }

      const stat = fs.statSync(clipPath);
      const totalSize = stat.size;
      const range = req.headers['range'];

      if (!range) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', totalSize);
        res.setHeader('Accept-Ranges', 'bytes');
        fs.createReadStream(clipPath).pipe(res);
        return;
      }

      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        return;
      }

      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : Math.min(start + 1048575, totalSize - 1);

      if (start >= totalSize || end < start) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        return;
      }

      res.statusCode = 206;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(clipPath, { start, end }).pipe(res);
      return;
    }

    next();
  };

  return {
    name: 'api-dev-middleware',
    configureServer(server) {
      server.middlewares.use(handleApiRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApiRequest);
    },
  };
}

export default defineConfig({
  plugins: [react(), createApiDevMiddlewarePlugin()],
  build: {
    copyPublicDir: false,
  },
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts'],
      exclude: ['src/shared/types.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
      },
    },
  },
});
