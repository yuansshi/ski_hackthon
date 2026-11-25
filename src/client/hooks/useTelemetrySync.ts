import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RaceComparisonManifest,
  SpatialSample,
  TemporalSample,
} from '../../shared/types.js';

export interface TelemetrySyncState {
  isPlaying: boolean;
  elapsedTimeSec: number;
  normalizedProgress: number;
  currentSpatialSampleA: SpatialSample;
  currentSpatialSampleB: SpatialSample;
  currentTemporalSampleA: TemporalSample;
  currentTemporalSampleB: TemporalSample;
  ghostDeltaSec: number; // negative = Athlete A faster / ahead
  spatialGapMeters: number; // d(s_A) - d(s_B)
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seekToProgress: (progress: number) => void;
  seekToTime: (timeSec: number) => void;
  stepFrames: (frames: number) => void;
  primaryVideoRef: React.RefObject<HTMLVideoElement>;
  secondaryVideoRef: React.RefObject<HTMLVideoElement>;
}

export function useTelemetrySync(
  manifest: RaceComparisonManifest,
  playbackSpeed: 0.5 | 1 | 2,
  syncMode: 'RACE_CLOCK' | 'SPATIAL_GHOST'
): TelemetrySyncState {
  const primaryVideoRef = useRef<HTMLVideoElement>(null);
  const secondaryVideoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [elapsedTimeSec, setElapsedTimeSec] = useState<number>(0);
  const [normalizedProgress, setNormalizedProgress] = useState<number>(0);

  // Keep a ref to the latest state to avoid recreate in rAF loop
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const elapsedTimeRef = useRef(elapsedTimeSec);
  elapsedTimeRef.current = elapsedTimeSec;

  const lastRafTimeRef = useRef<number | null>(null);

  const athleteA = manifest.athleteA;
  const athleteB = manifest.athleteB;
  const totalDuration = athleteA.totalTimeSec;

  const DEFAULT_SPATIAL_SAMPLE: SpatialSample = {
    progressIndex: 0,
    normalizedProgress: 0,
    distanceMeters: 0,
    elapsedTimeSec: 0,
    speedKmh: 0,
    speedMph: 0,
    speedUncertaintyKmh: 0,
    provenance: 'KINEMATIC_INTERPOLATED',
    gateNumber: null,
    pitchRatio: 0,
  };

  const DEFAULT_TEMPORAL_SAMPLE: TemporalSample = {
    timeIndex: 0,
    elapsedTimeSec: 0,
    normalizedProgress: 0,
    distanceMeters: 0,
    mapX: 500,
    mapY: 100,
    speedKmh: 0,
  };

  // Clamped sample helpers
  const getProgressSample = useCallback(
    (samples: SpatialSample[], s: number): SpatialSample => {
      if (!samples || samples.length === 0) return DEFAULT_SPATIAL_SAMPLE;
      const idx = Math.max(0, Math.min(samples.length - 1, Math.round(s * (samples.length - 1))));
      return samples[idx] ?? samples[0] ?? DEFAULT_SPATIAL_SAMPLE;
    },
    []
  );

  const getTimeSample = useCallback(
    (samples: TemporalSample[], t: number): TemporalSample => {
      if (!samples || samples.length === 0) return DEFAULT_TEMPORAL_SAMPLE;
      const idx = Math.max(0, Math.min(samples.length - 1, Math.round(t * 100)));
      return samples[idx] ?? samples[0] ?? DEFAULT_TEMPORAL_SAMPLE;
    },
    []
  );

  // Sync playback rates to video elements
  useEffect(() => {
    if (primaryVideoRef.current) {
      primaryVideoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  const seekToTime = useCallback(
    (timeSec: number) => {
      const targetT = Math.max(0, Math.min(totalDuration, timeSec));
      setElapsedTimeSec(targetT);

      // Seek primary video
      if (primaryVideoRef.current) {
        primaryVideoRef.current.currentTime = athleteA.startClipOffsetSec + targetT;
      }

      // Compute s_A
      const temporalA = getTimeSample(athleteA.samplesByTime, targetT);
      const sA = temporalA.normalizedProgress;
      setNormalizedProgress(sA);

      // Seek secondary video based on mode
      if (secondaryVideoRef.current) {
        if (syncMode === 'RACE_CLOCK') {
          secondaryVideoRef.current.currentTime = athleteB.startClipOffsetSec + targetT;
        } else {
          const spatialB = getProgressSample(athleteB.samplesByProgress, sA);
          secondaryVideoRef.current.currentTime =
            athleteB.startClipOffsetSec + spatialB.elapsedTimeSec;
        }
      }
    },
    [
      totalDuration,
      athleteA.startClipOffsetSec,
      athleteA.samplesByTime,
      athleteB.startClipOffsetSec,
      athleteB.samplesByProgress,
      syncMode,
      getTimeSample,
      getProgressSample,
    ]
  );

  const seekToProgress = useCallback(
    (progress: number) => {
      const s = Math.max(0, Math.min(1, progress));
      const spatialA = getProgressSample(athleteA.samplesByProgress, s);
      seekToTime(spatialA.elapsedTimeSec);
      setNormalizedProgress(s);
    },
    [athleteA.samplesByProgress, getProgressSample, seekToTime]
  );

  const play = useCallback(() => {
    setIsPlaying(true);
    if (primaryVideoRef.current) {
      primaryVideoRef.current.play().catch(() => {});
    }
    if (secondaryVideoRef.current) {
      secondaryVideoRef.current.play().catch(() => {});
    }
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
    if (primaryVideoRef.current) {
      primaryVideoRef.current.pause();
    }
    if (secondaryVideoRef.current) {
      secondaryVideoRef.current.pause();
    }
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlayingRef.current) {
      pause();
    } else {
      play();
    }
  }, [play, pause]);

  const stepFrames = useCallback(
    (frames: number) => {
      pause();
      const dt = frames / athleteA.nativeFps;
      seekToTime(elapsedTimeRef.current + dt);
    },
    [athleteA.nativeFps, pause, seekToTime]
  );

  // 60 Hz rAF Synchronization Loop
  useEffect(() => {
    let animId: number;

    const tick = (now: number) => {
      if (lastRafTimeRef.current === null) {
        lastRafTimeRef.current = now;
      }
      const deltaSec = (now - lastRafTimeRef.current) / 1000;
      lastRafTimeRef.current = now;

      if (isPlayingRef.current) {
        let currentRaceT = elapsedTimeRef.current;

        if (primaryVideoRef.current && !primaryVideoRef.current.paused) {
          // Drive from media clock if primary video is actively playing
          const mediaT = primaryVideoRef.current.currentTime - athleteA.startClipOffsetSec;
          currentRaceT = Math.max(0, Math.min(totalDuration, mediaT));
        } else {
          // Synthetic / simulation clock fallback
          currentRaceT = Math.min(totalDuration, currentRaceT + deltaSec * playbackSpeed);
        }

        if (currentRaceT >= totalDuration) {
          currentRaceT = totalDuration;
          setIsPlaying(false);
        }

        setElapsedTimeSec(currentRaceT);

        // O(1) index lookup into temporal samples
        const tSampleA = getTimeSample(athleteA.samplesByTime, currentRaceT);
        const sA = tSampleA.normalizedProgress;
        setNormalizedProgress(sA);

        // Synchronize secondary video
        if (secondaryVideoRef.current) {
          let secondaryTargetTimeSec: number;
          let velocityRatio = 1.0;

          if (syncMode === 'RACE_CLOCK') {
            secondaryTargetTimeSec = athleteB.startClipOffsetSec + currentRaceT;
          } else {
            const sSampleA = getProgressSample(athleteA.samplesByProgress, sA);
            const sSampleB = getProgressSample(athleteB.samplesByProgress, sA);
            secondaryTargetTimeSec = athleteB.startClipOffsetSec + sSampleB.elapsedTimeSec;
            if (sSampleB.speedKmh > 1) {
              velocityRatio = sSampleA.speedKmh / sSampleB.speedKmh;
            }
          }

          const currentSecTime = secondaryVideoRef.current.currentTime;
          const driftSec = secondaryTargetTimeSec - currentSecTime;
          const absDrift = Math.abs(driftSec);

          if (absDrift > 0.12) {
            // Hard seek if drift exceeds 120ms
            secondaryVideoRef.current.currentTime = secondaryTargetTimeSec;
          } else if (absDrift >= 0.04) {
            // Feed-forward rate modulation + proportional trim (quantized to 0.02x)
            const kp = 0.5;
            const targetRate = Math.max(
              0.5,
              Math.min(
                3.0,
                playbackSpeed * velocityRatio + kp * driftSec
              )
            );
            const quantizedRate = Math.round(targetRate * 50) / 50;
            if (Math.abs(secondaryVideoRef.current.playbackRate - quantizedRate) >= 0.02) {
              secondaryVideoRef.current.playbackRate = quantizedRate;
            }
          } else {
            // Inside deadband (40ms): match master playbackSpeed
            if (secondaryVideoRef.current.playbackRate !== playbackSpeed) {
              secondaryVideoRef.current.playbackRate = playbackSpeed;
            }
          }
        }
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [
    athleteA.startClipOffsetSec,
    athleteA.samplesByTime,
    athleteA.samplesByProgress,
    athleteB.startClipOffsetSec,
    athleteB.samplesByProgress,
    totalDuration,
    playbackSpeed,
    syncMode,
    getTimeSample,
    getProgressSample,
  ]);

  // Derive current samples
  const currentTemporalSampleA = getTimeSample(athleteA.samplesByTime, elapsedTimeSec);
  const currentTemporalSampleB = getTimeSample(athleteB.samplesByTime, elapsedTimeSec);

  const currentSpatialSampleA = getProgressSample(
    athleteA.samplesByProgress,
    normalizedProgress
  );
  const currentSpatialSampleB = getProgressSample(
    athleteB.samplesByProgress,
    normalizedProgress
  );

  // delta t(s) = t_A(s) - t_B(s)
  const ghostDeltaSec = Number(
    (currentSpatialSampleA.elapsedTimeSec - currentSpatialSampleB.elapsedTimeSec).toFixed(3)
  );

  // delta d(t) = d(s_A(t)) - d(s_B(t))
  const spatialGapMeters = Number(
    (currentTemporalSampleA.distanceMeters - currentTemporalSampleB.distanceMeters).toFixed(1)
  );

  return {
    isPlaying,
    elapsedTimeSec,
    normalizedProgress,
    currentSpatialSampleA,
    currentSpatialSampleB,
    currentTemporalSampleA,
    currentTemporalSampleB,
    ghostDeltaSec,
    spatialGapMeters,
    play,
    pause,
    togglePlay,
    seekToProgress,
    seekToTime,
    stepFrames,
    primaryVideoRef,
    secondaryVideoRef,
  };
}
