import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { inferCourseAnchors } from '../downhill/calibration.js';
import { decodeVideoLtc } from '../downhill/decode-video-ltc.js';
import {
  estimateRace,
  formatUtc,
  timeAtVideoPosition,
  toTelemetryCsv,
  type LtcSpan,
  type TelemetryPoint,
  type VideoMark,
} from '../downhill/telemetry.js';
import './analyze-downhill.css';

type Lane = 0 | 1;
type Pair<T> = [T, T];

type ClipDetails = {
  id: string;
  file: File;
  url: string;
  position: string;
};

type Clip = ClipDetails & (
  | { kind: 'queued' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; durationSec: number; spans: readonly LtcSpan[]; fromSec: number; toSec: number }
);

type ReadyClip = Extract<Clip, { kind: 'ready' }>;

type Mark = {
  id: string;
  kind: 'start' | 'landmark' | 'finish';
  name: string;
  distance: string;
  locations: Pair<VideoMark | null>;
};

type Racer = { name: string; clips: Clip[] };
type Comparison = ReturnType<typeof estimateRace>;

const sideColors = ['ice', 'amber'] as const;
const lanes: Pair<Lane> = [0, 1];

const startMark: Mark = {
  id: 'start', kind: 'start', name: 'Start', distance: '0', locations: [null, null],
};

const emptyRacers: Pair<Racer> = [{ name: '', clips: [] }, { name: '', clips: [] }];

function updatePair<T>(pair: Pair<T>, lane: Lane, callback: (item: T) => T): Pair<T> {
  return lane === 0 ? [callback(pair[0]), pair[1]] : [pair[0], callback(pair[1])];
}

function trimmedSpans(clip: ReadyClip): LtcSpan[] {
  return clip.spans.flatMap((span) => {
    const startVideoSec = Math.max(span.startVideoSec, clip.fromSec);
    const endVideoSec = Math.min(span.endVideoSec, clip.toSec);
    const startUtcSec = timeAtVideoPosition([span], startVideoSec);
    const endUtcSec = timeAtVideoPosition([span], endVideoSec);
    return endVideoSec > startVideoSec && startUtcSec !== null && endUtcSec !== null
      ? [{ startVideoSec, endVideoSec, startUtcSec, endUtcSec }]
      : [];
  });
}

async function playableDuration(url: string): Promise<number> {
  const video = document.createElement('video');
  try {
    await new Promise<void>((resolve, reject) => {
      video.preload = 'metadata';
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This browser cannot open the clip for playback.'));
      video.src = url;
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth === 0) {
      throw new Error('This clip has no playable video with a finite duration.');
    }
    return video.duration;
  } finally {
    video.onloadedmetadata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
  }
}

function saveCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  const filename = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  anchor.href = url;
  anchor.download = `${filename || 'athlete'}-telemetry.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface RacerWorkspaceProps {
  lane: Lane;
  racer: Racer;
  mark: Mark;
  onName: (name: string) => void;
  onFiles: (files: File[]) => void;
  onRemove: (clipId: string) => void;
  onPosition: (clipId: string, position: string) => void;
  onMark: (location: VideoMark) => void;
  onTrim: (clipId: string, edge: 'start' | 'end' | 'reset', seconds: number) => void;
}

function RacerWorkspace({
  lane, racer, mark, onName, onFiles, onRemove, onPosition, onMark, onTrim,
}: RacerWorkspaceProps) {
  const [selectedId, setSelectedId] = useState('');
  const [playhead, setPlayhead] = useState<{ clipId: string; seconds: number } | null>(null);
  const [seekInput, setSeekInput] = useState('');
  const [previewError, setPreviewError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const ready = racer.clips.filter((clip): clip is ReadyClip => clip.kind === 'ready');
  const current = ready.find((clip) => clip.id === selectedId) ?? ready[0];
  const seconds = current && playhead?.clipId === current.id ? playhead.seconds : 0;
  const utc = current ? timeAtVideoPosition(trimmedSpans(current), seconds) : null;
  const marked = ready.find((clip) => clip.id === mark.locations[lane]?.clipId);
  const recorded = mark.locations[lane];
  const caption = lane === 0 ? 'Racer A' : 'Racer B';

  function seek(seconds: number) {
    const element = video.current;
    if (!current || !element) return;
    element.pause();
    element.currentTime = Math.max(0, Math.min(seconds, current.durationSec));
  }

  function selectClip(clipId: string) {
    setPreviewError('');
    setSeekInput('');
    setSelectedId(clipId);
  }

  return (
    <section className={`downhill-racer downhill-${sideColors[lane]}`} aria-label={caption}>
      <label className="downhill-field">
        <span>{caption} name</span>
        <input value={racer.name} autoComplete="off" placeholder="Full name"
          onChange={(event) => onName(event.target.value)} />
      </label>
      <label className="downhill-upload">
        <span>Add {caption.toLowerCase()} clips</span>
        <small>MP4 or MOV</small>
        <input type="file" multiple accept="video/mp4,video/quicktime,.mp4,.mov"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            onFiles(files);
          }} />
      </label>
      {racer.clips.length > 0 && (
        <ul className="downhill-clip-list" aria-label={`${caption} clips`}>
          {racer.clips.map((clip) => (
            <li className="downhill-clip-row" key={clip.id}>
              <input type="number" inputMode="numeric" min="1" max="99" step="1"
                value={clip.position} aria-label={`Camera POS for ${clip.file.name}`}
                placeholder="POS" onChange={(event) => onPosition(clip.id, event.target.value)} />
              <span title={clip.file.name}>
                <b>{clip.file.name}</b>
                {clip.kind === 'ready' && (
                  <small data-testid={`downhill-ltc-ready-${lane}`}>
                    {formatUtc(clip.spans[0]?.startUtcSec ?? 0)} UTC
                  </small>
                )}
                {clip.kind === 'queued' && <small role="status">Reading audio timecode…</small>}
                {clip.kind === 'error' && <small className="downhill-error">{clip.message}</small>}
              </span>
              {clip.kind === 'ready' && (
                <button type="button" aria-pressed={clip.id === current?.id}
                  onClick={() => selectClip(clip.id)}>View</button>
              )}
              <button type="button" aria-label={`Remove ${clip.file.name}`}
                onClick={() => onRemove(clip.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="downhill-preview">
        {current ? (
          <video key={current.id} src={current.url} ref={video} muted playsInline controls preload="metadata"
            aria-label={`${caption} calibration preview`}
            onError={() => setPreviewError(current.id)}
            onTimeUpdate={(event) => setPlayhead({ clipId: current.id, seconds: event.currentTarget.currentTime })}
            onSeeked={(event) => setPlayhead({ clipId: current.id, seconds: event.currentTarget.currentTime })} />
        ) : (
          <span>Add timecoded footage to mark the course.</span>
        )}
      </div>
      {current && previewError === current.id && (
        <p className="downhill-error" role="alert">This browser cannot display the clip’s video codec.</p>
      )}
      {current && previewError !== current.id && (
        <div className="downhill-preview-controls">
          <div className="downhill-inline">
            <button type="button" onClick={() => seek(seconds - 0.04)} aria-label={`${caption} back 40 ms`}>−40 ms</button>
            <button type="button" onClick={() => seek(seconds + 0.04)} aria-label={`${caption} forward 40 ms`}>+40 ms</button>
            <output title="Clip time and audio timecode">
              {seconds.toFixed(2)}s {utc === null ? '· no usable timecode' : `· ${formatUtc(utc)} UTC`}
            </output>
          </div>
          <div className="downhill-inline">
            <label className="downhill-seek-time">
              <span className="downhill-sr-only">{caption} clip time (s)</span>
              <input type="number" inputMode="decimal" value={seekInput} step="any" min="0"
                max={current.durationSec} placeholder="Time (s)" onChange={(event) => setSeekInput(event.target.value)} />
            </label>
            <button type="button" disabled={!seekInput.trim()}
              onClick={() => seek(Number(seekInput))}>Seek</button>
            <button type="button" className="downhill-action" disabled={utc === null}
              onClick={() => {
                const element = video.current;
                if (!element || element.seeking || element.readyState < 2) return;
                element.pause();
                onMark({ clipId: current.id, videoSec: element.currentTime });
              }}>
              Mark {mark.name || 'point'}
            </button>
            {marked && recorded && (
              <output data-testid={`downhill-mark-${lane}`}>
                {marked.position ? `POS${marked.position}` : marked.file.name} · {recorded.videoSec.toFixed(2)}s
              </output>
            )}
          </div>
          <details className="downhill-trim">
            <summary>Limit footage to the skier’s visible interval</summary>
            <div className="downhill-inline">
              <button type="button" disabled={seconds >= current.toSec || utc === null}
                onClick={() => onTrim(current.id, 'start', seconds)}>Use from here</button>
              <button type="button" disabled={seconds <= current.fromSec || utc === null}
                onClick={() => onTrim(current.id, 'end', seconds)}>Use through here</button>
              <button type="button" onClick={() => onTrim(current.id, 'reset', 0)}>Reset</button>
              <output>{current.fromSec.toFixed(2)}–{current.toSec.toFixed(2)}s</output>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function ComparisonPane({
  lane, name, point, clip, nextPoint, playing,
}: {
  lane: Lane;
  name: string;
  point: TelemetryPoint | null;
  clip: ReadyClip | undefined;
  nextPoint: TelemetryPoint | null;
  playing: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const videoSec = point?.videoSec;
  const playbackRate = point && nextPoint?.clipId === point.clipId
    ? (nextPoint.videoSec - point.videoSec) * 10
    : 0;
  const nativeRate = playbackRate >= 0.25 && playbackRate <= 4 ? playbackRate : null;
  const source = clip?.url;
  const [brokenSource, setBrokenSource] = useState<string | undefined>();

  useEffect(() => {
    const element = video.current;
    if (!element || videoSec === undefined || !source || brokenSource === source) return;
    function syncImage(force: boolean) {
      if (!element || element.readyState < 1 || videoSec === undefined) return;
      const threshold = playing && nativeRate !== null ? 0.16 : 0.035;
      if (force || (!element.seeking && Math.abs(element.currentTime - videoSec) > threshold)) {
        element.currentTime = videoSec;
      }
      if (!playing || nativeRate === null) {
        if (!element.paused) element.pause();
        return;
      }
      if (Math.abs(element.playbackRate - nativeRate) > 0.02) element.playbackRate = nativeRate;
      if (element.paused) void element.play().catch(() => {});
    }
    function onLoaded() { syncImage(true); }
    element.addEventListener('loadedmetadata', onLoaded);
    syncImage(false);
    return () => element.removeEventListener('loadedmetadata', onLoaded);
  }, [videoSec, nativeRate, playing, source, brokenSource]);

  const broken = source !== undefined && source === brokenSource;

  return (
    <section className={`downhill-result-pane downhill-${sideColors[lane]}`} aria-label={name}>
      <div className="downhill-pane-header">
        <b>{name}</b>
        {clip?.position && <span>POS{clip.position}</span>}
      </div>
      <div className="downhill-result-video">
        {source && !broken ? (
          <video key={source} src={source} muted playsInline ref={video} preload="auto"
            aria-label={`${name} aligned video`} onError={() => setBrokenSource(source)} />
        ) : (
          <span>{broken ? 'Clip cannot be played in this browser' : 'No footage at this distance'}</span>
        )}
      </div>
      <div className="downhill-pane-timing">
        <span>Elapsed <strong>{point ? `${point.elapsedSec.toFixed(2)} s` : '—'}</strong></span>
        <span>Est. speed <strong>{point ? `${point.speedKmh.toFixed(1)} km/h` : '—'}</strong></span>
        {point && <span>±{point.speedUncertaintyKmh.toFixed(1)} km/h</span>}
      </div>
    </section>
  );
}

type TracePoint = { distanceM: number; speed: number; time: number };
type TraceSeries = (TracePoint | null)[];

function readTrace(comparison: Comparison): TraceSeries {
  const { startDistanceM, endDistanceM, athletes } = comparison;
  return Array.from({ length: 241 }, (_, index) => {
    const distanceM = startDistanceM + (endDistanceM - startDistanceM) * index / 240;
    const a = athletes[0].atDistance(distanceM);
    const b = athletes[1].atDistance(distanceM);
    return a && b ? { distanceM, speed: a.speedKmh - b.speedKmh, time: b.elapsedSec - a.elapsedSec } : null;
  });
}

function ComparisonTrace({ trace, metric, index, suffix }: {
  trace: TraceSeries;
  metric: 'speed' | 'time';
  index: number;
  suffix: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const label = metric === 'time' ? 'Time gain' : 'Speed difference';

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    function render() {
      if (!element) return;
      const ctx = element.getContext('2d');
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!ctx || width === 0 || height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      element.width = width * dpr;
      element.height = height * dpr;
      ctx.scale(dpr, dpr);
      const left = 39;
      const right = width - 7;
      const center = height / 2;
      const max = Math.max(0.1, ...trace.map((point) => Math.abs(point?.[metric] ?? 0)));
      function drawLine(x: number, y: number, endX: number, endY: number, stroke: string) {
        if (!ctx) return;
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
      ctx.font = '10px system-ui';
      ctx.fillStyle = '#97a8bd';
      ctx.fillText(`+${max.toFixed(1)}`, 0, 10);
      ctx.fillText('0', 0, center + 4);
      ctx.fillText(`−${max.toFixed(1)}`, 0, height - 2);
      drawLine(left, 8, right, 8, '#25364c');
      drawLine(left, center, right, center, '#3b514d');
      drawLine(left, height - 8, right, height - 8, '#25364c');
      const step = (right - left) / (trace.length - 1);
      ctx.lineWidth = 2;
      trace.forEach((point, i) => {
        const previous = trace[i - 1];
        if (!point || !previous) return;
        const from = center - previous[metric] / max * (center - 8);
        const to = center - point[metric] / max * (center - 8);
        drawLine(left + (i - 1) * step, from, left + i * step, to,
          point[metric] >= 0 ? '#7bddff' : '#ffc77c');
      });
    }

    const observer = new ResizeObserver(render);
    observer.observe(element);
    render();
    return () => observer.disconnect();
  }, [trace, metric]);

  const cursor = Math.max(0, Math.min(trace.length - 1, index)) / (trace.length - 1) * 100;

  return (
    <figure className="downhill-trace">
      <figcaption>{label} <span>{suffix}</span></figcaption>
      <div className="downhill-trace-plot">
        <canvas ref={canvas} role="img" aria-label={`${label} vs. distance, with zero as the center line`} />
        <div className="downhill-trace-cursor-inset" aria-hidden="true">
          <span style={{ left: `${cursor}%` }} />
        </div>
      </div>
    </figure>
  );
}

function describeComparison(comparison: Comparison, trace: TraceSeries) {
  let best: { start: TracePoint; end: TracePoint; gain: number } | null = null;
  let sectionStart: TracePoint | null = null;
  const stride = 16;
  for (let i = 0; i < trace.length; i++) {
    const point = trace[i];
    if (!point) {
      sectionStart = null;
      continue;
    }
    sectionStart ??= point;
    if (i % stride !== 0 && i !== trace.length - 1) continue;
    if (point.distanceM - sectionStart.distanceM >= 0.5) {
      const gain = point.time - sectionStart.time;
      if (!best || Math.abs(gain) > Math.abs(best.gain)) best = { start: sectionStart, end: point, gain };
    }
    sectionStart = point;
  }
  if (!best) return 'The marked interval has too little shared footage for a coaching comparison.';
  if (Math.abs(best.gain) < 0.16) return 'The estimated differences over shared footage are small compared with the timing precision.';
  const name = comparison.athletes[best.gain > 0 ? 0 : 1].name;
  const { distanceM: from } = best.start;
  const { distanceM: to } = best.end;
  const averageSpeed = comparison.athletes.map((athlete) => (
    3.6 * (to - from) / (athlete.elapsedAtDistance(to) - athlete.elapsedAtDistance(from))
  ));
  const difference = Math.abs(averageSpeed[0] - averageSpeed[1]);
  return `${name} gained an estimated ${Math.abs(best.gain).toFixed(2)} s from ${Math.round(from)} to ${Math.round(to)} m, with an average speed advantage of ${difference.toFixed(1)} km/h. Scrub to that section to compare their lines.`;
}

function RunComparison({ comparison, racers, hasInferredDistance }: {
  comparison: Comparison;
  racers: Pair<Racer>;
  hasInferredDistance: boolean;
}) {
  const { athletes, startDistanceM, endDistanceM } = comparison;
  const [distance, setDistance] = useState(startDistanceM);
  const [playing, setPlaying] = useState(false);
  const cursor = useRef(distance);
  cursor.current = distance;
  const trace = useMemo(() => readTrace(comparison), [comparison]);
  const summary = useMemo(() => describeComparison(comparison, trace), [comparison, trace]);
  const noOverlap = trace.every((point) => point === null);
  const points: Pair<TelemetryPoint | null> = [athletes[0].atDistance(distance), athletes[1].atDistance(distance)];
  const delta = points[0] && points[1] ? points[1].elapsedSec - points[0].elapsedSec : null;
  const traceIndex = (distance - startDistanceM) / (endDistanceM - startDistanceM) * (trace.length - 1);
  const ahead = delta === null || Math.abs(delta) < 0.005 ? null : athletes[delta > 0 ? 0 : 1].name;
  const leadElapsed = athletes[0].elapsedAtDistance(distance);
  const nextDistance = athletes[0].distanceAtElapsed(leadElapsed + 0.1);

  useEffect(() => {
    if (!playing) return;
    const first = performance.now();
    const startElapsed = athletes[0].elapsedAtDistance(cursor.current);
    let animation = 0;
    let lastPaint = first - 50;
    function tick(now: number) {
      if (now - lastPaint >= 32) {
        const next = athletes[0].distanceAtElapsed(startElapsed + (now - first) / 1000);
        setDistance(next);
        lastPaint = now;
        if (next >= endDistanceM - 1e-6) {
          setPlaying(false);
          return;
        }
      }
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, athletes, endDistanceM]);

  return (
    <section className="downhill-comparison" aria-label="Synchronized race comparison">
      <header className="downhill-result-header">
        <div>
          <h3>Side-by-side comparison</h3>
          <p>Both videos follow the same estimated course distance.</p>
        </div>
        <output aria-label="Lead at this distance">
          {delta === null ? 'No shared footage' : ahead === null ? 'Even' : `${ahead} leads by ${Math.abs(delta).toFixed(2)} s`}
        </output>
      </header>
      {noOverlap && <p className="downhill-error" role="status">The marked intervals have no shared timecoded footage.</p>}
      <div className="downhill-pair">
        {lanes.map((lane) => {
          const point = points[lane];
          const clip = racers[lane].clips.find((item): item is ReadyClip => item.kind === 'ready' && item.id === point?.clipId);
          return (
            <ComparisonPane key={lane} lane={lane} name={athletes[lane].name}
              point={point} clip={clip} playing={playing} nextPoint={athletes[lane].atDistance(nextDistance)} />
          );
        })}
      </div>
      <div className="downhill-transport">
        <button type="button" className="downhill-action" onClick={() => {
          if (distance >= endDistanceM - 1e-6) {
            cursor.current = startDistanceM;
            setDistance(startDistanceM);
          }
          setPlaying(!playing);
        }}>{playing ? 'Pause comparison' : 'Play comparison'}</button>
        <label>
          <span className="downhill-sr-only">Course distance</span>
          <input type="range" min={startDistanceM} max={endDistanceM} value={distance} step="any"
            onChange={(event) => {
              setPlaying(false);
              setDistance(Number(event.target.value));
            }} />
        </label>
        <output>{Math.round(distance)} m</output>
      </div>
      <div className="downhill-trace-key">
        <span className="downhill-ice">{athletes[0].name} above zero</span>
        <span className="downhill-amber">{athletes[1].name} below zero</span>
      </div>
      <ComparisonTrace trace={trace} metric="speed" index={traceIndex} suffix="km/h" />
      <ComparisonTrace trace={trace} metric="time" index={traceIndex} suffix="s" />
      <div className="downhill-result-notes">
        <div>
          <h4>Coaching readout</h4>
          <p>{summary}</p>
          <p>Speed estimates average the distance between your marks. Gaps indicate unavailable footage.</p>
          {hasInferredDistance && <p>Distances you left blank use elapsed time and course scale. The speed ranges include an allowance for that estimate.</p>}
        </div>
        <div className="downhill-downloads">
          {athletes.map((athlete) => (
            <button key={athlete.name} type="button" onClick={() => saveCsv(athlete.name, toTelemetryCsv(athlete))}>
              Download {athlete.name} CSV
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function AnalyzeDownhill() {
  const [racers, setRacers] = useState<Pair<Racer>>(emptyRacers);
  const [length, setLength] = useState('');
  const [startAltitude, setStartAltitude] = useState('');
  const [finishAltitude, setFinishAltitude] = useState('');
  const [marks, setMarks] = useState<Mark[]>([startMark]);
  const [activeMarkId, setActiveMarkId] = useState(startMark.id);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    comparison: Comparison;
    racers: Pair<Racer>;
    hasInferredDistance: boolean;
  } | null>(null);
  const urls = useRef(new Map<string, string>());
  const decodeQueue = useRef(Promise.resolve());
  const resultRegion = useRef<HTMLDivElement>(null);
  const activeMark = marks.find((mark) => mark.id === activeMarkId) ?? startMark;

  useEffect(() => {
    const activeUrls = urls.current;
    return () => {
      for (const url of activeUrls.values()) URL.revokeObjectURL(url);
      activeUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (result) resultRegion.current?.focus({ preventScroll: false });
  }, [result]);

  function clearResult() {
    setResult(null);
    setError('');
  }

  function updateRacer(lane: Lane, callback: (racer: Racer) => Racer) {
    setRacers((pair) => updatePair(pair, lane, callback));
  }

  function updateClip(lane: Lane, clipId: string, callback: (clip: Clip) => Clip) {
    updateRacer(lane, (racer) => ({
      ...racer,
      clips: racer.clips.map((clip) => clip.id === clipId ? callback(clip) : clip),
    }));
  }

  function addFiles(lane: Lane, files: File[]) {
    clearResult();
    const clips = files.map((file): ClipDetails => {
      const id = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      urls.current.set(id, url);
      const position = file.name.match(/(?:^|[^A-Z0-9])POS0?(\d+)\b/i)?.[1] ?? '';
      return { id, file, url, position };
    });
    updateRacer(lane, (racer) => ({
      ...racer,
      clips: [...racer.clips, ...clips.map((clip): Clip => ({ ...clip, kind: 'queued' }))],
    }));
    for (const clip of clips) {
      decodeQueue.current = decodeQueue.current.then(async () => {
        if (!urls.current.has(clip.id)) return;
        try {
          const visibleDurationSec = await playableDuration(clip.url);
          if (!urls.current.has(clip.id)) return;
          const decoded = await decodeVideoLtc(clip.file);
          if (decoded.spans.length === 0) throw new Error('No readable left-channel LTC.');
          if (!urls.current.has(clip.id)) return;
          const durationSec = Math.min(decoded.durationSec, visibleDurationSec);
          const ready: ReadyClip = { ...clip, kind: 'ready', durationSec, spans: decoded.spans,
            fromSec: 0, toSec: durationSec };
          if (trimmedSpans(ready).length === 0) throw new Error('The timecode falls outside the clip’s playable video.');
          updateClip(lane, clip.id, (current) => ({ ...ready, position: current.position }));
        } catch (failure) {
          if (!urls.current.has(clip.id)) return;
          const message = failure instanceof Error ? failure.message : 'Could not read audio timecode.';
          updateClip(lane, clip.id, (current) => ({ ...current, kind: 'error', message }));
        }
      });
    }
  }

  function removeClip(lane: Lane, clipId: string) {
    clearResult();
    const url = urls.current.get(clipId);
    if (url) URL.revokeObjectURL(url);
    urls.current.delete(clipId);
    updateRacer(lane, (racer) => ({ ...racer, clips: racer.clips.filter((clip) => clip.id !== clipId) }));
    setMarks((current) => current.map((mark) => ({
      ...mark,
      locations: updatePair(mark.locations, lane, (location) => location?.clipId === clipId ? null : location),
    })));
  }

  function addMark(kind: 'landmark' | 'finish') {
    clearResult();
    const id = crypto.randomUUID();
    setMarks((current) => [...current, {
      id, kind, name: kind === 'finish' ? 'Finish' : `Landmark ${current.filter((mark) => mark.kind === 'landmark').length + 1}`,
      distance: '', locations: [null, null],
    }]);
    setActiveMarkId(id);
  }

  function updateMark(callback: (mark: Mark) => Mark) {
    clearResult();
    setMarks((current) => current.map((mark) => mark.id === activeMark.id ? callback(mark) : mark));
  }

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const courseLengthM = Number(length);
      if (!Number.isFinite(courseLengthM) || courseLengthM <= 0) throw new Error('Enter the course length in meters.');
      if (startAltitude.trim() === '' || finishAltitude.trim() === '') throw new Error('Enter both course altitudes.');
      if (Number(startAltitude) <= Number(finishAltitude)) throw new Error('Start altitude must be above finish altitude.');
      if (racers.some((racer) => !racer.name.trim())) throw new Error('Enter both racer names.');
      if (racers[0].name.trim().toLowerCase() === racers[1].name.trim().toLowerCase()) throw new Error('Use two distinct racer names.');
      if (racers.some((racer) => racer.clips.some((clip) => clip.kind === 'queued'))) {
        throw new Error('Wait for the remaining audio timecodes to load.');
      }
      const course = {
        lengthM: courseLengthM,
        startAltitudeM: Number(startAltitude),
        finishAltitudeM: Number(finishAltitude),
      };
      if (!Number.isFinite(course.startAltitudeM) || !Number.isFinite(course.finishAltitudeM)) {
        throw new Error('Enter finite values for both course altitudes.');
      }
      const prepared = (racer: Racer) => ({
        name: racer.name.trim(),
        clips: racer.clips.flatMap((clip) => {
          if (clip.kind !== 'ready') return [];
          if (!/^\d+$/.test(clip.position) || Number(clip.position) < 1 || Number(clip.position) > 99) {
            throw new Error(`Enter a camera position for ${clip.file.name}.`);
          }
          return [{ id: clip.id, source: clip.file.name, spans: trimmedSpans(clip) }];
        }),
      });
      const athletes: Pair<ReturnType<typeof prepared>> = [prepared(racers[0]), prepared(racers[1])];
      const [start, ...landmarks] = marks.map((mark) => {
        const [a, b] = mark.locations;
        if (!a || !b) throw new Error(`Mark ${mark.name || 'this point'} for both racers.`);
        const distanceM = mark.kind === 'finish' ? courseLengthM : mark.distance.trim() ? Number(mark.distance) : null;
        if (mark.kind === 'landmark' && distanceM !== null && (!(distanceM > 0) || distanceM >= courseLengthM)) {
          throw new Error(`Enter a distance within the course for ${mark.name || 'this landmark'}.`);
        }
        const pair: Pair<VideoMark> = [a, b];
        const times: Pair<number> = [0, 0];
        for (const lane of lanes) {
          const reference = pair[lane];
          const clip = athletes[lane].clips.find((item) => item.id === reference.clipId);
          const utc = timeAtVideoPosition(clip?.spans ?? [], reference.videoSec);
          if (utc === null) throw new Error(`Mark ${mark.name || 'this point'} inside ${athletes[lane].name}’s timecoded footage.`);
          times[lane] = utc;
        }
        return { distanceM, name: mark.name, times, marks: pair };
      });
      if (landmarks.length === 0) throw new Error('Mark a matching landmark or the finish for both racers.');
      const anchors = inferCourseAnchors(course, start, landmarks);
      const comparison = estimateRace({ courseLengthM, athletes, anchors });
      const hasInferredDistance = landmarks.some((mark) => mark.distanceM === null);
      setError('');
      setResult({ comparison, racers, hasInferredDistance });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Check that both races have timecoded course marks.');
      setResult(null);
    }
  }

  const updateCourseField = (value: string, change: (value: string) => void) => {
    clearResult();
    change(value);
  };

  return (
    <section className="downhill-workbench" aria-labelledby="downhill-workbench-title">
      <header className="downhill-workbench-header">
        <h2 id="downhill-workbench-title">Analyze your race footage</h2>
        <p>Load the two racers’ timecoded clips, then mark where they pass the same points on the course. The videos stay in your browser.</p>
      </header>
      <form className="downhill-analysis-form" onSubmit={analyze} noValidate>
        <fieldset className="downhill-course">
          <legend>Course details</legend>
          <label className="downhill-field">
            <span>Length (m)</span>
            <input type="number" min="1" step="any" inputMode="decimal" value={length}
              onChange={(event) => updateCourseField(event.target.value, setLength)} />
          </label>
          <label className="downhill-field">
            <span>Start altitude (m)</span>
            <input type="number" step="any" inputMode="decimal" value={startAltitude}
              onChange={(event) => updateCourseField(event.target.value, setStartAltitude)} />
          </label>
          <label className="downhill-field">
            <span>Finish altitude (m)</span>
            <input type="number" step="any" inputMode="decimal" value={finishAltitude}
              onChange={(event) => updateCourseField(event.target.value, setFinishAltitude)} />
          </label>
        </fieldset>

        <section className="downhill-calibration" aria-labelledby="downhill-marks-title">
          <div className="downhill-calibration-header">
            <div>
              <h3 id="downhill-marks-title">Match the runs</h3>
              <p>Mark the start in each run, then mark the finish or another point you can see in both runs.</p>
            </div>
            <div className="downhill-inline">
              <button type="button" onClick={() => addMark('landmark')}>Add landmark</button>
              {!marks.some((mark) => mark.kind === 'finish') && <button type="button" onClick={() => addMark('finish')}>Add finish</button>}
            </div>
          </div>
          <div className="downhill-markbar" aria-label="Course marks">
            {marks.map((mark, index) => (
              <button key={mark.id} type="button" aria-pressed={activeMark.id === mark.id}
                onClick={() => setActiveMarkId(mark.id)}>
                {mark.name || `Landmark ${index}`} <span>{mark.locations.filter(Boolean).length}/2</span>
              </button>
            ))}
          </div>
          {activeMark.kind !== 'start' && (
            <div className="downhill-mark-fields">
              {activeMark.kind === 'landmark' ? (
                <>
                  <label className="downhill-field">
                    <span>Landmark name</span>
                    <input value={activeMark.name} onChange={(event) => updateMark((mark) => ({ ...mark, name: event.target.value }))} />
                  </label>
                  <label className="downhill-field">
                    <span>Course distance (m), optional</span>
                    <input type="number" inputMode="decimal" min="0" step="any" value={activeMark.distance} placeholder="Estimate from footage"
                      onChange={(event) => updateMark((mark) => ({ ...mark, distance: event.target.value }))} />
                  </label>
                </>
              ) : (
                <span>Finish distance · {length || 'Set course length'}{length ? ' m' : ''}</span>
              )}
              <button type="button" onClick={() => {
                clearResult();
                setMarks((current) => current.filter((mark) => mark.id !== activeMark.id));
                setActiveMarkId(startMark.id);
              }}>Remove {activeMark.kind}</button>
            </div>
          )}
          <div className="downhill-pair">
            {lanes.map((lane) => (
              <RacerWorkspace key={lane} lane={lane} racer={racers[lane]} mark={activeMark}
                onName={(name) => { clearResult(); updateRacer(lane, (racer) => ({ ...racer, name })); }}
                onFiles={(files) => addFiles(lane, files)}
                onRemove={(clipId) => removeClip(lane, clipId)}
                onPosition={(clipId, position) => {
                  clearResult();
                  updateClip(lane, clipId, (clip) => ({ ...clip, position }));
                }}
                onMark={(location) => updateMark((mark) => ({
                  ...mark, locations: updatePair(mark.locations, lane, () => location),
                }))}
                onTrim={(clipId, edge, seconds) => {
                  clearResult();
                  updateClip(lane, clipId, (clip) => {
                    if (clip.kind !== 'ready') return clip;
                    if (edge === 'reset') return { ...clip, fromSec: 0, toSec: clip.durationSec };
                    return edge === 'start' ? { ...clip, fromSec: seconds } : { ...clip, toSec: seconds };
                  });
                }} />
            ))}
          </div>
        </section>
        <div className="downhill-submit">
          <button type="submit" className="downhill-action">Analyze comparison</button>
          {error && <p className="downhill-error" role="alert">{error}</p>}
        </div>
      </form>
      {result && (
        <div ref={resultRegion} tabIndex={-1} className="downhill-result-region">
          <RunComparison comparison={result.comparison} racers={result.racers}
            hasInferredDistance={result.hasInferredDistance} />
        </div>
      )}
    </section>
  );
}
