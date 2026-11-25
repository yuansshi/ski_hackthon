import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealGpsTrack, type GpsTrack } from './downhill-gnss.js';

interface ClipTarget {
  clipKey: string;
  athleteId: string;
  runDurationSec: number;
}

interface DownhillClipTarget extends ClipTarget {
  raceId: 'beaver-creek-men-dh-2025';
  multiCamCode: 'RYACOC' | 'BRYBEN';
  gpsCsvFilename: string;
  simulatedRunDurationSec: number;
}

export type ClipTargetSpec = DownhillClipTarget | (ClipTarget & {
  raceId: 'beaver-creek-men-sg-2025';
});

interface DownhillClipSource {
  files: string[];
  track: GpsTrack;
}

export interface MultiCamZoneSpec {
  posNumber: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  sectionLabel: string;
  startProgress: number;
  endProgress: number;
  clipInSec: number;
}

export const MULTI_CAM_POS_ZONES: MultiCamZoneSpec[] = [
  { posNumber: 1, sectionLabel: 'Start House & Upper Flat', startProgress: 0.0, endProgress: 0.14, clipInSec: 3.0 },
  { posNumber: 2, sectionLabel: 'Flyaway & The Brink Entry', startProgress: 0.14, endProgress: 0.22, clipInSec: 16.5 },
  { posNumber: 3, sectionLabel: 'The Brink Rollover & Talon', startProgress: 0.22, endProgress: 0.33, clipInSec: 3.0 },
  { posNumber: 4, sectionLabel: 'Talon Steep & Screech Owl Jump', startProgress: 0.33, endProgress: 0.505, clipInSec: 2.0 },
  { posNumber: 5, sectionLabel: 'Peregrine Steep & Golden Eagle Approach', startProgress: 0.505, endProgress: 0.665, clipInSec: 13.0 },
  { posNumber: 6, sectionLabel: 'Golden Eagle & Abyss Compression', startProgress: 0.665, endProgress: 0.8, clipInSec: 2.0 },
  { posNumber: 7, sectionLabel: 'Harrier Technical Turns', startProgress: 0.8, endProgress: 0.92, clipInSec: 5.5 },
  { posNumber: 8, sectionLabel: 'STIFEL Arch, Red Tail Jump & Finish', startProgress: 0.92, endProgress: 1.0, clipInSec: 7.5 },
];

export const DOWNHILL_CLIP_TARGETS = [
  {
    clipKey: 'dh-athlete-a.mp4',
    raceId: 'beaver-creek-men-dh-2025',
    athleteId: 'cochran-siegle-dh',
    multiCamCode: 'RYACOC',
    gpsCsvFilename: 'Ryan Cochran-Siegle-Beaver Creek_251203_DH-Tr.2-2025-12-03-Runs.csv',
    runDurationSec: 93.89,
    simulatedRunDurationSec: 99.84,
  },
  {
    clipKey: 'dh-athlete-b.mp4',
    raceId: 'beaver-creek-men-dh-2025',
    athleteId: 'bennett-dh',
    multiCamCode: 'BRYBEN',
    gpsCsvFilename: 'BryceBennett-Beaver Creek_251203_DH-Tr.2-2025-12-03-Runs.csv',
    runDurationSec: 94.72,
    simulatedRunDurationSec: 100.41,
  },
] satisfies readonly [DownhillClipTarget, DownhillClipTarget];

const TARGET_ATHLETE_CLIPS: ClipTargetSpec[] = [
  {
    clipKey: 'sg-athlete-a.mp4',
    raceId: 'beaver-creek-men-sg-2025',
    athleteId: 'odermatt-sg',
    runDurationSec: 71.48,
  },
  {
    clipKey: 'sg-athlete-b.mp4',
    raceId: 'beaver-creek-men-sg-2025',
    athleteId: 'cochran-siegle-sg',
    runDurationSec: 71.92,
  },
  ...DOWNHILL_CLIP_TARGETS,
];

export async function probeGoogleDriveMp4Header(
  driveFileId: string
): Promise<{ status: number; contentRange: string | null; isMp4Header: boolean }> {
  const url = `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`;
  try {
    const resp = await fetch(url, {
      headers: {
        Range: 'bytes=0-65535',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    const buf = new Uint8Array(await resp.arrayBuffer());
    const magic =
      buf.length >= 8
        ? String.fromCharCode(buf[4], buf[5], buf[6], buf[7])
        : '';
    return {
      status: resp.status,
      contentRange: resp.headers.get('content-range'),
      isMp4Header: magic === 'ftyp',
    };
  } catch {
    return { status: 0, contentRange: null, isMp4Header: false };
  }
}

export function resolveMultiCamPosFiles(
  multiCamCode: string,
  rawPosDir = path.resolve(process.cwd(), 'public/clips/raw_pos')
): string[] | null {
  function findPositions(): string[] | null {
    const files = fs.existsSync(rawPosDir) ? fs.readdirSync(rawPosDir) : [];
    const posPaths: string[] = [];
    for (const { posNumber } of MULTI_CAM_POS_ZONES) {
      const match = files.find((file) =>
        file.toUpperCase().startsWith(`${multiCamCode}_`) &&
        file.toUpperCase().includes('_DH_') &&
        file.toUpperCase().endsWith(`_POS${posNumber}.MP4`)
      );
      if (!match) return null;
      posPaths.push(path.join(rawPosDir, match));
    }
    return posPaths;
  }

  const existing = findPositions();
  if (existing) return existing;

  const zipCandidates = fs.readdirSync(process.cwd())
    .filter((file) => file.startsWith('Beaver Creek Downhill Video-') && file.endsWith('.zip'))
    .sort();
  if (zipCandidates.length === 0) return null;

  fs.mkdirSync(rawPosDir, { recursive: true });
  for (const zip of zipCandidates) {
    try {
      execFileSync('unzip', [
        '-j', '-n', path.resolve(zip), `*${multiCamCode}_*_DH_*_POS*`, '-d', rawPosDir,
      ], { stdio: 'ignore' });
    } catch (error) {
      // unzip returns 11 when the archive contains no files matching this athlete.
      if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 11) {
        throw error;
      }
    }
  }
  return findPositions();
}

export function resolveDownhillComparisonSources(): ReadonlyMap<string, DownhillClipSource> {
  const pair = new Map<string, DownhillClipSource>();
  for (const target of DOWNHILL_CLIP_TARGETS) {
    const track = loadRealGpsTrack(target.gpsCsvFilename);
    if (!track) return new Map();
    const files = resolveMultiCamPosFiles(target.multiCamCode);
    if (!files) return new Map();
    pair.set(target.clipKey, { files, track });
  }
  return pair;
}

export function ensureKeyframeMp4Clip(
  spec: ClipTargetSpec,
  clipsDir = path.resolve(process.cwd(), 'public/clips'),
  forcedDurationSec?: number,
  downhillSources = spec.raceId === 'beaver-creek-men-dh-2025'
    ? resolveDownhillComparisonSources()
    : new Map<string, DownhillClipSource>()
): string {
  fs.mkdirSync(clipsDir, { recursive: true });
  const outPath = path.join(clipsDir, spec.clipKey);
  const markerPath = `${outPath}.duration`;
  const source = downhillSources.get(spec.clipKey);
  const runDurationSec = spec.raceId === 'beaver-creek-men-dh-2025' && !source
    ? spec.simulatedRunDurationSec
    : spec.runDurationSec;
  const clipDurationSec = forcedDurationSec ?? Number((runDurationSec + 3.0).toFixed(2));
  const modeTag = source && spec.raceId === 'beaver-creek-men-dh-2025'
    ? `MULTICAM_8POS_AV1_${spec.multiCamCode}`
    : 'SYNTHETIC_DEMO_H264';
  const expectedMarker = `${clipDurationSec}:${modeTag}`;

  if (
    fs.existsSync(outPath) &&
    fs.statSync(outPath).size > 1024 &&
    fs.existsSync(markerPath) &&
    fs.readFileSync(markerPath, 'utf-8').trim() === expectedMarker
  ) {
    return outPath;
  }

  if (source && spec.raceId === 'beaver-creek-men-dh-2025') {
    const elapsedTimeScale = spec.runDurationSec / source.track.totalTimeSec;
    const inputArgs: string[] = [];
    const filterParts: string[] = [];
    const accentHex = spec.multiCamCode === 'RYACOC' ? '0x06b6d4' : '0xf59e0b';

    for (let idx = 0; idx < MULTI_CAM_POS_ZONES.length; idx++) {
      const zone = MULTI_CAM_POS_ZONES[idx];
      const posPath = source.files[idx];
      const t0 = source.track.sampleAtProgress(zone.startProgress).elapsedTimeSec * elapsedTimeScale;
      const t1 = source.track.sampleAtProgress(zone.endProgress).elapsedTimeSec * elapsedTimeScale;
      const segDur = Math.max(0.5, t1 - t0);
      const actualIn = zone.posNumber === 1 ? Math.max(0, zone.clipInSec - 1.5) : zone.clipInSec;
      const actualDur =
        zone.posNumber === 1 || zone.posNumber === 8 ? segDur + 1.5 : segDur;

      inputArgs.push('-ss', actualIn.toFixed(4), '-t', actualDur.toFixed(4), '-i', posPath);

      const activeX = 960 - 180 + (zone.posNumber - 1) * 21;
      filterParts.push(
        `[${idx}:v]fps=30000/1001,scale=960:540,setsar=1,format=yuv420p,` +
          `drawbox=x=774:y=10:w=176:h=16:color=0x020617@0.75:t=fill,` +
          `drawbox=x=${activeX}:y=13:w=18:h=10:color=${accentHex}@0.95:t=fill[v${idx}];`
      );
    }

    const concatInputs = MULTI_CAM_POS_ZONES.map((_, idx) => `[v${idx}]`).join('');
    const filterComplex = `${filterParts.join('')}${concatInputs}concat=n=8:v=1:a=0[outv]`;

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        ...inputArgs,
        '-filter_complex',
        filterComplex,
        '-map',
        '[outv]',
        '-c:v',
        'libsvtav1',
        '-preset',
        '10',
        '-crf',
        '28',
        '-g',
        '15',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { stdio: 'ignore' }
    );
    fs.writeFileSync(markerPath, expectedMarker, 'utf-8');
    return outPath;
  }

  const bgHex = spec.raceId === 'beaver-creek-men-sg-2025' ? '0x0f172a' : '0x111827';
  const accentHex = spec.athleteId.includes('odermatt') ? '0x06b6d4' : '0xf59e0b';
  const gateRedHex = spec.raceId === 'beaver-creek-men-sg-2025' ? '0xef4444' : '0xf97316';
  const gateBlueHex = spec.raceId === 'beaver-creek-men-sg-2025' ? '0x3b82f6' : '0xf97316';

  const vfFilter = [
    `drawbox=x=120:y=40:w=400:h=270:color=0x1e293b@0.75:t=fill`,
    `drawbox=x='180+40*sin(t*1.7)':y='40+mod(t*140\\,250)':w=10:h=34:color=${gateRedHex}@0.95:t=fill`,
    `drawbox=x='430+40*cos(t*1.7)':y='40+mod(t*140+125\\,250)':w=10:h=34:color=${gateBlueHex}@0.95:t=fill`,
    `drawbox=x='295+95*sin(t*2.4)':y='185+20*cos(t*4.8)':w=34:h=34:color=${accentHex}@0.95:t=fill`,
    `drawbox=x=0:y=0:w=640:h=28:color=0x020617@0.9:t=fill`,
    `drawbox=x=10:y=10:w='620*min(1\\,t/${clipDurationSec})':h=8:color=${accentHex}@0.9:t=fill`,
    `drawbox=x=0:y=310:w=640:h=50:color=0x020617@0.9:t=fill`,
    'scale=960:540',
  ].join(',');

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${bgHex}:s=640x360:r=30000/1001:d=${clipDurationSec}`,
      '-vf',
      vfFilter,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { stdio: 'ignore' }
  );
  fs.writeFileSync(markerPath, expectedMarker, 'utf-8');

  return outPath;
}

export async function ensureAllClips(
  clipsDir = path.resolve(process.cwd(), 'public/clips')
): Promise<string[]> {
  const downhillSources = resolveDownhillComparisonSources();
  return TARGET_ATHLETE_CLIPS.map((spec) =>
    ensureKeyframeMp4Clip(spec, clipsDir, undefined, downhillSources)
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  ensureAllClips().then((created) => {
    console.log(
      `[download-and-clip] Prepared ${created.length} keyframe-optimized MP4 clips in public/clips/`
    );
  });
}
