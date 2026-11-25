import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AthleteRunTelemetry } from '../../shared/types.js';

type AthleteBox = [centerX: number, centerY: number, width: number, height: number];

interface FrameTrack {
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  startFrame: number;
  tracks: (AthleteBox | null)[];
}

function isAthleteBox(value: unknown): value is AthleteBox {
  return Array.isArray(value) && value.length === 4 && value.every(
    (coordinate: unknown) => typeof coordinate === 'number' && coordinate >= 0 && coordinate <= 1
  ) && value[2] > 0 && value[3] > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseTrack(value: unknown, source: string): FrameTrack | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('source' in value) || value.source !== source || !('version' in value) || value.version !== 1) return null;
  if (!('width' in value) || !isPositiveInteger(value.width)) return null;
  if (!('height' in value) || !isPositiveInteger(value.height)) return null;
  if (!('fpsNumerator' in value) || !isPositiveInteger(value.fpsNumerator)) return null;
  if (!('fpsDenominator' in value) || !isPositiveInteger(value.fpsDenominator)) return null;
  if (!('tracks' in value) || !Array.isArray(value.tracks)) return null;
  const startFrame = 'startFrame' in value ? value.startFrame : 0;
  if (startFrame !== 0 && !isPositiveInteger(startFrame)) return null;
  const tracks: (AthleteBox | null)[] = [];
  for (const box of value.tracks) {
    if (box !== null && !isAthleteBox(box)) return null;
    tracks.push(box);
  }
  return {
    width: value.width,
    height: value.height,
    fpsNumerator: value.fpsNumerator,
    fpsDenominator: value.fpsDenominator,
    startFrame,
    tracks,
  };
}

interface TrackedAthleteVideoProps {
  athlete: AthleteRunTelemetry;
  videoRef: RefObject<HTMLVideoElement>;
  onLoadedMetadata: () => void;
  accent: 'cyan' | 'amber';
  showTrack: boolean;
  muted?: boolean;
  hidden?: boolean;
  cameraPosition?: number;
}

export function TrackedAthleteVideo({
  athlete, videoRef, onLoadedMetadata, accent, showTrack, muted = false, hidden = false, cameraPosition,
}: TrackedAthleteVideoProps) {
  const [error, setError] = useState(false);
  const [track, setTrack] = useState<FrameTrack | null>(null);
  const marker = useRef<HTMLDivElement>(null);
  const presentedTime = useRef<number | null>(null);
  const paintMarker = useRef<() => void>(() => {});
  const clipUrl = athlete.clipUrl;

  useEffect(() => {
    if (!showTrack) return;
    const source = new URL(clipUrl, window.location.href).pathname.split('/').at(-1);
    if (!source) return;
    const abort = new AbortController();
    fetch(`/data/tracks/${encodeURIComponent(source)}.json`, { signal: abort.signal })
      .then(async (response) => response.ok ? parseTrack(await response.json(), source) : null)
      .then((nextTrack) => {
        if (!abort.signal.aborted) setTrack(nextTrack);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [clipUrl, showTrack]);

  useEffect(() => {
    const video = videoRef.current;
    const label = marker.current;
    if (!video || !label) return;
    paintMarker.current = () => {
      const time = presentedTime.current;
      if (time === null || !track || !showTrack || hidden || error || video.seeking) {
        label.hidden = true;
        return;
      }
      const frameIndex = Math.round(time * track.fpsNumerator / track.fpsDenominator);
      const box = track.tracks[frameIndex - track.startFrame];
      if (box && video.videoWidth === track.width && video.videoHeight === track.height) {
        const [centerX, centerY, , height] = box;
        label.style.setProperty('--marker-x', `${centerX * 100}%`);
        label.style.setProperty('--marker-y', `${Math.max(0, centerY - height / 2) * 100}%`);
        label.dataset.frame = String(frameIndex);
        label.hidden = false;
      } else {
        label.hidden = true;
      }
    };
    paintMarker.current();
  }, [videoRef, track, showTrack, hidden, error]);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video?.requestVideoFrameCallback || !showTrack) return;
    const clearFrame = () => {
      presentedTime.current = null;
      paintMarker.current();
    };
    let callbackId = 0;
    const draw = (_now: number, frame: VideoFrameCallbackMetadata) => {
      presentedTime.current = frame.mediaTime;
      paintMarker.current();
      callbackId = video.requestVideoFrameCallback(draw);
    };
    const paintPresentedFrame = () => paintMarker.current();
    video.addEventListener('seeking', clearFrame);
    video.addEventListener('seeked', paintPresentedFrame);
    video.addEventListener('emptied', clearFrame);
    callbackId = video.requestVideoFrameCallback(draw);
    return () => {
      video.cancelVideoFrameCallback(callbackId);
      video.removeEventListener('seeking', clearFrame);
      video.removeEventListener('seeked', paintPresentedFrame);
      video.removeEventListener('emptied', clearFrame);
      clearFrame();
    };
  }, [videoRef, showTrack]);

  const [givenName, ...surname] = athlete.athleteName.split(' ');
  const alias = surname.join(' ') || givenName;
  return (
    <section className={`athlete-video athlete-video--${accent}`} hidden={hidden}>
      <div className="athlete-video-heading">
        <span>{athlete.athleteName}</span>
        {cameraPosition !== undefined && <small>POS{cameraPosition}</small>}
      </div>
      <div className="athlete-video-frame">
        <video ref={videoRef} src={clipUrl} muted={muted} playsInline preload="auto"
          aria-label={`${athlete.athleteName} run`} onLoadedMetadata={onLoadedMetadata}
          onError={() => setError(true)} />
        <div className="athlete-frame-marker" ref={marker} aria-hidden="true" hidden>
          <span>{alias}</span>
        </div>
        {error && <p className="athlete-video-error" role="status">Clip unavailable</p>}
      </div>
    </section>
  );
}
