import type { Env } from '../races/index.js';

const VALID_CLIPS = new Set([
  'sg-athlete-a.mp4',
  'sg-athlete-b.mp4',
  'dh-athlete-a.mp4',
  'dh-athlete-b.mp4',
]);

export function parseByteRangeHeader(
  rangeHeader: string | null,
  totalSize: number
): { valid: boolean; offset: number; end: number; length: number } {
  if (!rangeHeader) {
    const end = Math.max(0, totalSize - 1);
    return { valid: true, offset: 0, end, length: totalSize };
  }

  if (!rangeHeader.startsWith('bytes=')) {
    return { valid: false, offset: 0, end: 0, length: 0 };
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { valid: false, offset: 0, end: 0, length: 0 };
  }

  const offset = Number(match[1]);
  const end =
    match[2].length > 0
      ? Number(match[2])
      : Math.min(offset + 1048575, totalSize - 1);

  if (
    !Number.isFinite(offset) ||
    !Number.isFinite(end) ||
    offset < 0 ||
    offset >= totalSize ||
    end < offset ||
    end >= totalSize
  ) {
    return { valid: false, offset, end, length: 0 };
  }

  return {
    valid: true,
    offset,
    end,
    length: end - offset + 1,
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const clipKey = String(context.params.clipKey ?? '');
  if (!VALID_CLIPS.has(clipKey)) {
    return new Response(JSON.stringify({ error: `Unknown clipKey: ${clipKey}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const rangeHeader = context.request.headers.get('Range') ?? context.request.headers.get('range');

  if (context.env?.R2_CLIPS) {
    // First probe object size or fetch range from R2
    const headObj = await context.env.R2_CLIPS.head(clipKey);
    if (!headObj) {
      return new Response(JSON.stringify({ error: `Clip not found in R2: ${clipKey}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const parsed = parseByteRangeHeader(rangeHeader, headObj.size);
    if (!parsed.valid) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${headObj.size}`,
        },
      });
    }

    const r2Obj = await context.env.R2_CLIPS.get(clipKey, {
      range: { offset: parsed.offset, length: parsed.length },
    });
    if (!r2Obj || !('body' in r2Obj) || !r2Obj.body) {
      return new Response(JSON.stringify({ error: `Failed to read R2 slice for ${clipKey}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const status = rangeHeader ? 206 : 200;
    return new Response(r2Obj.body, {
      status,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${parsed.offset}-${parsed.end}/${headObj.size}`,
        'Content-Length': String(parsed.length),
        ETag: headObj.httpEtag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  const assetUrl = new URL(`/clips/${clipKey}`, context.request.url);
  return context.next(new Request(assetUrl, context.request));
};
