import fs from 'node:fs';
import path from 'node:path';

export interface GpsTrackPoint {
  s: number;
  elapsedTimeSec: number;
  distanceMeters: number;
  elevationMeters: number;
  speedKmh: number;
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface GpsTrack {
  totalTimeSec: number;
  totalDistanceMeters: number;
  totalVerticalDropMeters: number;
  points: GpsTrackPoint[];
  sampleAtProgress: (s: number) => { elapsedTimeSec: number; speedKmh: number; elevationMeters: number };
}

export function loadRealGpsTrack(csvFilename: string): GpsTrack | null {
  const csvPath = path.resolve(
    process.cwd(),
    'Beaver Creek Downhill GPS Data',
    csvFilename
  );
  if (!fs.existsSync(csvPath)) return null;

  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
  if (lines.length < 10) return null;
  const headers = lines[0].split(',');
  const tIdx = headers.indexOf('run-elapsed_time[s]');
  const dIdx = headers.indexOf('distance[m]');
  const eIdx = headers.indexOf('elevation[m]');
  const vIdx = headers.indexOf('speed[km/h]');
  const latIdx = headers.indexOf('Latitude[deg]');
  const lonIdx = headers.indexOf('Longitude[deg]');
  const splitIdx = headers.indexOf('split-name');

  const rawRows: Array<{
    t: number;
    d: number;
    elev: number;
    spd: number;
    lat: number | null;
    lon: number | null;
  }> = [];

  for (let index = 1; index < lines.length; index++) {
    const cols = lines[index].split(',');
    const required = [tIdx, dIdx, eIdx, vIdx].map((index) => cols[index]?.trim());
    if (required.some((value) => !value)) return null;
    const [t, d, elev, spd] = required.map(Number);
    if (![t, d, elev, spd].every(Number.isFinite) || t < 0 || d < 0 || spd < 0) return null;
    const previous = rawRows.at(-1);
    // The exported finish event can correct the distance of the preceding sample.
    const finishEvent = index === lines.length - 1 && cols[splitIdx]?.trim() === 'Finish';
    if (previous && (t <= previous.t || (d < previous.d && !finishEvent))) return null;

    const lat = cols[latIdx]?.trim() ? Number(cols[latIdx]) : NaN;
    const lon = cols[lonIdx]?.trim() ? Number(cols[lonIdx]) : NaN;
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon);
    rawRows.push({ t, d, elev, spd, lat: hasCoordinates ? lat : null, lon: hasCoordinates ? lon : null });
  }

  if (rawRows.length < 10) return null;
  const coordinateRows = rawRows.flatMap(({ lat, lon }) =>
    lat !== null && lon !== null ? [{ lat, lon }] : []
  );
  const firstLatRow = coordinateRows[0];
  const lastLatRow = coordinateRows.at(-1);
  if (!firstLatRow || !lastLatRow) return null;

  const { d: totalDistanceMeters, t: totalTimeSec, elev: endElev } = rawRows[rawRows.length - 1];
  if (totalDistanceMeters <= 0 || totalTimeSec <= 0) return null;
  const totalVerticalDropMeters = Number((rawRows[0].elev - endElev).toFixed(2));

  const points: GpsTrackPoint[] = rawRows.map((r, idx) => {
    const s = Math.max(0, Math.min(1, r.d / totalDistanceMeters));
    const fallbackLat =
      idx < rawRows.length / 2 ? firstLatRow.lat : lastLatRow.lat;
    const fallbackLon = idx < rawRows.length / 2 ? firstLatRow.lon : lastLatRow.lon;
    return {
      s,
      elapsedTimeSec: r.t,
      distanceMeters: r.d,
      elevationMeters: r.elev,
      speedKmh: r.spd,
      latitudeDeg: r.lat ?? fallbackLat,
      longitudeDeg: r.lon ?? fallbackLon,
    };
  });

  const sampleAtProgress = (s: number) => {
    const clampedS = Math.max(0, Math.min(1, s));
    if (clampedS <= 0) {
      return {
        elapsedTimeSec: 0,
        speedKmh: points[0].speedKmh,
        elevationMeters: points[0].elevationMeters,
      };
    }
    if (clampedS >= 1) {
      const last = points[points.length - 1];
      return {
        elapsedTimeSec: totalTimeSec,
        speedKmh: last.speedKmh,
        elevationMeters: last.elevationMeters,
      };
    }
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i].s <= clampedS && clampedS <= points[i + 1].s) {
        const span = Math.max(1e-9, points[i + 1].s - points[i].s);
        const frac = (clampedS - points[i].s) / span;
        return {
          elapsedTimeSec: Number(
            (points[i].elapsedTimeSec + frac * (points[i + 1].elapsedTimeSec - points[i].elapsedTimeSec)).toFixed(4)
          ),
          speedKmh: Number(
            (points[i].speedKmh + frac * (points[i + 1].speedKmh - points[i].speedKmh)).toFixed(2)
          ),
          elevationMeters: Number(
            (points[i].elevationMeters + frac * (points[i + 1].elevationMeters - points[i].elevationMeters)).toFixed(2)
          ),
        };
      }
    }
    const last = points[points.length - 1];
    return {
      elapsedTimeSec: totalTimeSec,
      speedKmh: last.speedKmh,
      elevationMeters: last.elevationMeters,
    };
  };

  return {
    totalTimeSec,
    totalDistanceMeters,
    totalVerticalDropMeters,
    points,
    sampleAtProgress,
  };
}
