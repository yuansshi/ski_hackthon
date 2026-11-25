import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CourseProfile,
  SpatialSample,
  TemporalSample,
} from '../../shared/types.js';

export type Reconstructor3DViewMode = 'SPLIT_3D' | 'CHASE_3D' | 'MOUNTAIN_3D';

export interface Slope3DReconstructorProps {
  course: CourseProfile;
  samplesA: SpatialSample[];
  samplesB: SpatialSample[];
  temporalSampleA: TemporalSample;
  temporalSampleB: TemporalSample;
  spatialSampleA: SpatialSample;
  spatialSampleB: SpatialSample;
  spatialGapMeters: number;
  ghostDeltaSec: number;
  athleteAName: string;
  athleteBName: string;
  onSeekToProgress: (s: number) => void;
  defaultViewMode?: Reconstructor3DViewMode;
  compact?: boolean;
}

interface SpinePoint3D {
  s: number;
  wx: number; // world X in normalized [-1, 1]
  wy: number; // world Y in normalized [-1, 1]
  wz: number; // elevation in meters
  curvature: number; // signed turn curvature
  pitchPct: number;
  speedA: number;
  speedB: number;
  lineOffsetA: number; // lateral offset on slope in meters [-5, +5]
  lineOffsetB: number; // lateral offset on slope in meters [-5, +5]
}

function speedToColor(speedKmh: number, alpha = 1): string {
  // 65 km/h (blue) -> 95 km/h (cyan) -> 110 km/h (emerald) -> 125+ km/h (amber/orange)
  const t = Math.max(0, Math.min(1, (speedKmh - 65) / 62));
  let r = 14;
  let g = 165;
  let b = 233;
  if (t < 0.35) {
    const u = t / 0.35;
    r = Math.round(59 + u * (6 - 59));
    g = Math.round(130 + u * (182 - 130));
    b = Math.round(246 + u * (212 - 246));
  } else if (t < 0.7) {
    const u = (t - 0.35) / 0.35;
    r = Math.round(6 + u * (16 - 6));
    g = Math.round(182 + u * (185 - 182));
    b = Math.round(212 + u * (129 - 212));
  } else {
    const u = (t - 0.7) / 0.3;
    r = Math.round(16 + u * (245 - 16));
    g = Math.round(185 + u * (158 - 185));
    b = Math.round(129 + u * (11 - 129));
  }
  return alpha >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const Slope3DReconstructor: React.FC<Slope3DReconstructorProps> = ({
  course,
  samplesA,
  samplesB,
  temporalSampleA,
  temporalSampleB,
  spatialSampleA,
  spatialSampleB,
  spatialGapMeters,
  ghostDeltaSec,
  athleteAName,
  athleteBName,
  onSeekToProgress,
  defaultViewMode = 'SPLIT_3D',
  compact = false,
}) => {
  const [viewMode, setViewMode] = useState<Reconstructor3DViewMode>(defaultViewMode);
  const [chaseYawDeg, setChaseYawDeg] = useState<number>(0);
  const [mountainYawDeg, setMountainYawDeg] = useState<number>(-24);
  const [mountainPitchDeg, setMountainPitchDeg] = useState<number>(38);
  const dragStateRef = useRef<{
    active: boolean;
    target: 'CHASE' | 'MOUNTAIN';
    startX: number;
    startY: number;
    initYaw: number;
    initPitch: number;
    moved: boolean;
  }>({
    active: false,
    target: 'MOUNTAIN',
    startX: 0,
    startY: 0,
    initYaw: -24,
    initPitch: 38,
    moved: false,
  });

  const chaseCanvasRef = useRef<HTMLCanvasElement>(null);
  const mountainCanvasRef = useRef<HTMLCanvasElement>(null);
  const projectedMountainPointsRef = useRef<Array<{ s: number; sx: number; sy: number }>>([]);

  // Build 1,001-point 3D mountain spine from real GPS trailSpline2D + 10 Hz speed telemetry
  const spine3D = useMemo<SpinePoint3D[]>(() => {
    const pts = course.trailSpline2D;
    const n = pts.length;
    if (n === 0) return [];

    const startElev = course.hasGpsCourseMap ? 3360 : 3483;
    const dropM = course.totalVerticalDropMeters || 611.4;
    const rawCurv = new Float32Array(n);

    for (let i = 2; i < n - 2; i++) {
      const dx1 = pts[i].x - pts[i - 2].x;
      const dy1 = pts[i].y - pts[i - 2].y;
      const dx2 = pts[i + 2].x - pts[i].x;
      const dy2 = pts[i + 2].y - pts[i].y;
      const cross = dx1 * dy2 - dy1 * dx2;
      const norm = Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) + 1e-3;
      rawCurv[i] = Math.max(-1, Math.min(1, (cross / norm) * 6.5));
    }

    const smoothCurv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = -4; k <= 4; k++) {
        const idx = Math.max(0, Math.min(n - 1, i + k));
        sum += rawCurv[idx];
        cnt++;
      }
      smoothCurv[i] = sum / cnt;
    }

    const result: SpinePoint3D[] = new Array(n);
    let cumZ = startElev;
    const baseStepDrop = dropM / Math.max(1, n - 1);

    for (let i = 0; i < n; i++) {
      const s = pts[i].s;
      const sA = samplesA[Math.min(samplesA.length - 1, i)];
      const sB = samplesB[Math.min(samplesB.length - 1, i)];
      const pitchPct = Math.round(((sA?.pitchRatio ?? pts[i].pitchRatio ?? 0.45) * 100));
      if (i > 0) {
        cumZ -= baseStepDrop * (0.65 + (pitchPct / 45) * 0.35);
      }
      const speedA = sA?.speedKmh ?? 100;
      const speedB = sB?.speedKmh ?? 100;
      const curv = smoothCurv[i];

      const apexLine = Math.sin(s * Math.PI * 22) * 1.65 + curv * 2.1;
      const speedShift = Math.max(-1.2, Math.min(1.2, (speedB - speedA) * 0.28));

      result[i] = {
        s,
        wx: (pts[i].x - 500) / 380,
        wy: (pts[i].y - 500) / 380,
        wz: pts[i].elevationMeters || cumZ,
        curvature: curv,
        pitchPct,
        speedA,
        speedB,
        lineOffsetA: Math.max(-4.6, Math.min(4.6, apexLine - 1.65)),
        lineOffsetB: Math.max(-4.6, Math.min(4.6, apexLine + 1.65 + speedShift)),
      };
    }
    return result;
  }, [course, samplesA, samplesB]);

  // 1. Render 3D Slope Chase-Cam (3D Terrain Corridor + 2 Articulated 3D Skiers + Speed Ribbon)
  useEffect(() => {
    if (viewMode === 'MOUNTAIN_3D') return;
    const canvas = chaseCanvasRef.current;
    if (!canvas || spine3D.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Sky & Alpine Mountain Backdrop Gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.36);
    skyGrad.addColorStop(0, '#020617');
    skyGrad.addColorStop(0.65, '#0f172a');
    skyGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // Distant 3D Mountain Ridge Silhouette
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.29);
    const yawShift = chaseYawDeg * 3.2;
    for (let x = 0; x <= W; x += 24) {
      const ridgeY =
        H * 0.24 -
        Math.sin((x + yawShift) * 0.014) * 14 -
        Math.cos((x - yawShift) * 0.031) * 8;
      ctx.lineTo(x, ridgeY);
    }
    ctx.lineTo(W, H * 0.36);
    ctx.lineTo(0, H * 0.36);
    ctx.closePath();
    ctx.fill();

    const sA = temporalSampleA.normalizedProgress;
    const sB = temporalSampleB.normalizedProgress;
    const trailS = Math.min(sA, sB);
    const totalLen = course.totalDistanceMeters || 2349.17;

    const sampleSpine = (sQuery: number): SpinePoint3D => {
      const clamped = Math.max(0, Math.min(1, sQuery));
      const fIdx = clamped * (spine3D.length - 1);
      const i0 = Math.floor(fIdx);
      const i1 = Math.min(spine3D.length - 1, i0 + 1);
      const t = fIdx - i0;
      const p0 = spine3D[i0];
      const p1 = spine3D[i1];
      return {
        s: clamped,
        wx: p0.wx + (p1.wx - p0.wx) * t,
        wy: p0.wy + (p1.wy - p0.wy) * t,
        wz: p0.wz + (p1.wz - p0.wz) * t,
        curvature: p0.curvature + (p1.curvature - p0.curvature) * t,
        pitchPct: p0.pitchPct + (p1.pitchPct - p0.pitchPct) * t,
        speedA: p0.speedA + (p1.speedA - p0.speedA) * t,
        speedB: p0.speedB + (p1.speedB - p0.speedB) * t,
        lineOffsetA: p0.lineOffsetA + (p1.lineOffsetA - p0.lineOffsetA) * t,
        lineOffsetB: p0.lineOffsetB + (p1.lineOffsetB - p0.lineOffsetB) * t,
      };
    };

    const refPt = sampleSpine(trailS);
    const yawRad = (chaseYawDeg * Math.PI) / 180;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);
    const focal = W * 0.72;
    const horizonY = H * 0.23;

    // True 3D perspective ground projection:
    // Camera is 13m behind aheadMeters=0 and elevated above the tilted downhill slope plane
    const projectSlope3D = (
      lateralMeters: number,
      aheadMeters: number,
      heightAboveSnowM = 0
    ): { sx: number; sy: number; scale: number; depth: number } => {
      const ptAhead = sampleSpine(trailS + aheadMeters / totalLen);
      const curveBendM =
        (ptAhead.curvature - refPt.curvature * 0.25) *
        Math.max(0, aheadMeters) *
        0.24;

      const worldX = lateralMeters + curveBendM;
      const worldZ = aheadMeters + 13;
      const rotX = worldX * cosY - (worldZ - 13) * sinY * 0.24;
      const depth = Math.max(4.5, worldZ + worldX * sinY * 0.12);

      const scale = focal / depth;
      const camHeightM = 6.2 + (ptAhead.pitchPct - 42) * 0.03;
      const sx = W * 0.5 + rotX * scale;
      const sy = horizonY + (camHeightM - heightAboveSnowM) * scale;
      return { sx, sy, scale, depth };
    };

    // Draw 3D Snow Slope Corridor Slices from far (+85m ahead) to near (-6m behind)
    const corridorHalfWidthM = 8.0;
    const stepM = 2.5;
    for (let dM = 85; dM >= -5; dM -= stepM) {
      const dFar = dM + stepM;
      const sSlice = trailS + dM / totalLen;
      if (sSlice < -0.02 || sSlice > 1.02) continue;

      const slicePt = sampleSpine(sSlice);
      const pFL = projectSlope3D(-corridorHalfWidthM, dFar, 0);
      const pFR = projectSlope3D(corridorHalfWidthM, dFar, 0);
      const pNL = projectSlope3D(-corridorHalfWidthM, dM, 0);
      const pNR = projectSlope3D(corridorHalfWidthM, dM, 0);

      // Outer snow shoulder
      const pOFL = projectSlope3D(-corridorHalfWidthM * 2.1, dFar, -0.4);
      const pOFR = projectSlope3D(corridorHalfWidthM * 2.1, dFar, -0.4);
      const pONL = projectSlope3D(-corridorHalfWidthM * 2.1, dM, -0.4);
      const pONR = projectSlope3D(corridorHalfWidthM * 2.1, dM, -0.4);

      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.moveTo(pOFL.sx, pOFL.sy);
      ctx.lineTo(pOFR.sx, pOFR.sy);
      ctx.lineTo(pONR.sx, pONR.sy);
      ctx.lineTo(pONL.sx, pONL.sy);
      ctx.closePath();
      ctx.fill();

      // Main 3D Groomed Snow Slope Quad
      const distFade = Math.max(0.18, Math.min(1, 1 - dM / 100));
      const stripe = Math.floor((sSlice * totalLen) / 5) % 2 === 0;
      const baseLuma = stripe ? 38 : 32;
      const rSnow = Math.round(baseLuma * distFade + 12);
      const gSnow = Math.round((baseLuma + 14) * distFade + 18);
      const bSnow = Math.round((baseLuma + 34) * distFade + 30);

      ctx.fillStyle = `rgb(${rSnow}, ${gSnow}, ${bSnow})`;
      ctx.beginPath();
      ctx.moveTo(pFL.sx, pFL.sy);
      ctx.lineTo(pFR.sx, pFR.sy);
      ctx.lineTo(pNR.sx, pNR.sy);
      ctx.lineTo(pNL.sx, pNL.sy);
      ctx.closePath();
      ctx.fill();

      // 3D Terrain Contour Grid Rib
      ctx.strokeStyle = `rgba(148, 163, 184, ${0.18 * distFade})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pNL.sx, pNL.sy);
      ctx.lineTo(pNR.sx, pNR.sy);
      ctx.stroke();

      // 3D Left & Right Crimson B-Net Safety Fencing
      const pFLTop = projectSlope3D(-corridorHalfWidthM, dFar, 1.35);
      const pNLTop = projectSlope3D(-corridorHalfWidthM, dM, 1.35);
      ctx.fillStyle = `rgba(225, 29, 72, ${0.34 * distFade})`;
      ctx.beginPath();
      ctx.moveTo(pFL.sx, pFL.sy);
      ctx.lineTo(pFLTop.sx, pFLTop.sy);
      ctx.lineTo(pNLTop.sx, pNLTop.sy);
      ctx.lineTo(pNL.sx, pNL.sy);
      ctx.closePath();
      ctx.fill();

      const pFRTop = projectSlope3D(corridorHalfWidthM, dFar, 1.35);
      const pNRTop = projectSlope3D(corridorHalfWidthM, dM, 1.35);
      ctx.beginPath();
      ctx.moveTo(pFR.sx, pFR.sy);
      ctx.lineTo(pFRTop.sx, pFRTop.sy);
      ctx.lineTo(pNRTop.sx, pNRTop.sy);
      ctx.lineTo(pNR.sx, pNR.sy);
      ctx.closePath();
      ctx.fill();

      // 3D Speed Heatmap Ribbon & Dual Carved Ski Tracks on the Snow
      const pTrackFarA = projectSlope3D(
        sampleSpine(sSlice + stepM / totalLen).lineOffsetA,
        dFar,
        0.04
      );
      const pTrackNearA = projectSlope3D(slicePt.lineOffsetA, dM, 0.04);

      const pTrackFarB = projectSlope3D(
        sampleSpine(sSlice + stepM / totalLen).lineOffsetB,
        dFar,
        0.04
      );
      const pTrackNearB = projectSlope3D(slicePt.lineOffsetB, dM, 0.04);

      ctx.strokeStyle = `rgba(245, 158, 11, ${0.72 * distFade})`;
      ctx.lineWidth = Math.max(1.5, 3.0 * distFade);
      ctx.beginPath();
      ctx.moveTo(pTrackFarB.sx, pTrackFarB.sy);
      ctx.lineTo(pTrackNearB.sx, pTrackNearB.sy);
      ctx.stroke();

      ctx.strokeStyle = speedToColor(slicePt.speedA, 0.92 * distFade);
      ctx.lineWidth = Math.max(2, 4.0 * distFade);
      ctx.beginPath();
      ctx.moveTo(pTrackFarA.sx, pTrackFarA.sy);
      ctx.lineTo(pTrackNearA.sx, pTrackNearA.sy);
      ctx.stroke();
    }

    // Draw 3D Race Gates inside the visible 3D corridor window
    for (const gate of course.gates) {
      const gateAheadM = (gate.normalizedProgress - trailS) * totalLen;
      if (gateAheadM < -4 || gateAheadM > 84) continue;

      const gateSpine = sampleSpine(gate.normalizedProgress);
      const gateCenterX = gateSpine.lineOffsetA * 0.45;
      const gateColor =
        gate.color === 'BLUE'
          ? '#3b82f6'
          : gate.color === 'ORANGE'
            ? '#f97316'
            : gate.color === 'FINISH'
              ? '#10b981'
              : '#ef4444';

      for (const side of [-1, 1]) {
        const gx = gateCenterX + side * 4.4;
        const pBase1 = projectSlope3D(gx - 0.35, gateAheadM, 0);
        const pTop1 = projectSlope3D(gx - 0.35, gateAheadM, 2.2);
        const pBase2 = projectSlope3D(gx + 0.35, gateAheadM, 0);
        const pTop2 = projectSlope3D(gx + 0.35, gateAheadM, 2.2);

        ctx.strokeStyle = gateColor;
        ctx.lineWidth = Math.max(1.4, pBase1.scale * 0.08);
        ctx.beginPath();
        ctx.moveTo(pBase1.sx, pBase1.sy);
        ctx.lineTo(pTop1.sx, pTop1.sy);
        ctx.moveTo(pBase2.sx, pBase2.sy);
        ctx.lineTo(pTop2.sx, pTop2.sy);
        ctx.stroke();

        ctx.fillStyle = gateColor;
        ctx.globalAlpha = 0.78;
        ctx.beginPath();
        ctx.moveTo(pTop1.sx, pTop1.sy);
        ctx.lineTo(pTop2.sx, pTop2.sy);
        ctx.lineTo(
          pBase2.sx + (pTop2.sx - pBase2.sx) * 0.35,
          pBase2.sy + (pTop2.sy - pBase2.sy) * 0.35
        );
        ctx.lineTo(
          pBase1.sx + (pTop1.sx - pBase1.sx) * 0.35,
          pBase1.sy + (pTop1.sy - pBase1.sy) * 0.35
        );
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      const pGateTag = projectSlope3D(gateCenterX - 5.2, gateAheadM, 2.4);
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`G${gate.gateNumber}`, pGateTag.sx, pGateTag.sy);
    }

    // Position both skiers in the mid-ground of the 3D slope:
    // Trailing skier sits at +3.5m in front of camera baseline; Leading skier sits further down the slope at +3.5m + visualGapM
    const ptA = sampleSpine(sA);
    const ptB = sampleSpine(sB);
    const visualGapM = Math.min(30, Math.max(4.5, Math.abs(spatialGapMeters) * 1.15));

    const aheadMA = spatialGapMeters >= 0 ? 3.5 + visualGapM : 3.5;
    const aheadMB = spatialGapMeters >= 0 ? 3.5 : 3.5 + visualGapM;

    const posA3D = projectSlope3D(ptA.lineOffsetA, aheadMA, 0);
    const posB3D = projectSlope3D(ptB.lineOffsetB, aheadMB, 0);

    // Draw 3D On-Snow Laser Distance Tether between Main Skier A and Ghost Skier B
    const isMainAhead = ghostDeltaSec <= 0;
    ctx.save();
    ctx.strokeStyle = isMainAhead
      ? 'rgba(16, 185, 129, 0.92)'
      : 'rgba(244, 63, 94, 0.92)';
    ctx.lineWidth = 2.4;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(posA3D.sx, posA3D.sy);
    ctx.lineTo(posB3D.sx, posB3D.sy);
    ctx.stroke();
    ctx.setLineDash([]);

    const midX = Math.max(64, Math.min(posA3D.sx, posB3D.sx) - 54);
    const midY = (posA3D.sy + posB3D.sy) * 0.5 + 4;
    const gapLabel = `${ghostDeltaSec <= 0 ? '' : '+'}${ghostDeltaSec.toFixed(2)}s (${spatialGapMeters >= 0 ? '+' : ''}${spatialGapMeters.toFixed(1)}m)`;
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    const gTw = ctx.measureText(gapLabel).width + 12;
    ctx.fillStyle = 'rgba(2, 6, 23, 0.92)';
    ctx.beginPath();
    ctx.roundRect(midX - gTw * 0.5, midY - 9, gTw, 18, 5);
    ctx.fill();
    ctx.strokeStyle = isMainAhead ? '#10b981' : '#f43f5e';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = isMainAhead ? '#34d399' : '#fb7185';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gapLabel, midX, midY);
    ctx.restore();

    const draw3DSkierAvatar = (
      lateralM: number,
      aheadM: number,
      curvature: number,
      speedKmh: number,
      label: string,
      isGhost: boolean,
      avoidY?: number
    ) => {
      const pFoot = projectSlope3D(lateralM, aheadM, 0);
      const pHip = projectSlope3D(lateralM, aheadM - 0.25, 0.85);
      const pHead = projectSlope3D(lateralM, aheadM + 0.15, 1.42);
      const sc = Math.max(0.5, Math.min(1.65, pFoot.scale * 0.044));

      const leanRad = Math.max(
        -0.52,
        Math.min(0.52, curvature * (speedKmh / 95) * 0.65)
      );
      const leanPx = Math.sin(leanRad) * 16 * sc;

      ctx.save();
      ctx.globalAlpha = isGhost ? 0.78 : 1.0;

      // 1. Glowing 3D Ground Speed Ring on Snow
      ctx.fillStyle = isGhost
        ? 'rgba(245, 158, 11, 0.24)'
        : 'rgba(6, 182, 212, 0.28)';
      ctx.beginPath();
      ctx.ellipse(pFoot.sx, pFoot.sy, 20 * sc, 7.5 * sc, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isGhost ? '#f59e0b' : '#22d3ee';
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // 2. Dual 3D Carving Skis
      const skiColor = isGhost ? '#fcd34d' : '#38bdf8';
      for (const skiSide of [-1, 1]) {
        const skiX = pFoot.sx + skiSide * 5 * sc;
        const skiY = pFoot.sy;
        ctx.strokeStyle = skiColor;
        ctx.lineWidth = Math.max(2, 3 * sc);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(skiX - leanPx * 0.18, skiY - 10 * sc);
        ctx.lineTo(skiX + leanPx * 0.18, skiY + 8 * sc);
        ctx.stroke();
      }

      // 3. Articulated Legs & Aerodynamic Tuck Torso
      const hipX = pHip.sx + leanPx * 0.65;
      const hipY = pHip.sy;
      const shoulderX = pHead.sx + leanPx;
      const shoulderY = pHead.sy + 5 * sc;

      ctx.strokeStyle = isGhost ? '#f59e0b' : '#0284c7';
      ctx.lineWidth = Math.max(2.2, 3.8 * sc);
      ctx.beginPath();
      ctx.moveTo(pFoot.sx - 4 * sc, pFoot.sy);
      ctx.lineTo(hipX - 3 * sc, hipY);
      ctx.moveTo(pFoot.sx + 4 * sc, pFoot.sy);
      ctx.lineTo(hipX + 3 * sc, hipY);
      ctx.stroke();

      ctx.fillStyle = isGhost ? 'rgba(245, 158, 11, 0.88)' : '#0ea5e9';
      ctx.strokeStyle = isGhost ? '#fef08a' : '#e0f2fe';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(
        (hipX + shoulderX) * 0.5,
        (hipY + shoulderY) * 0.5,
        8 * sc,
        11 * sc,
        leanRad * 0.6,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.stroke();

      // 4. Ski Poles
      ctx.strokeStyle = isGhost ? '#fde68a' : '#bae6fd';
      ctx.lineWidth = Math.max(1.2, 1.6 * sc);
      ctx.beginPath();
      ctx.moveTo(shoulderX - 7.5 * sc, shoulderY + 2 * sc);
      ctx.lineTo(hipX - 15 * sc, hipY - 7 * sc);
      ctx.moveTo(shoulderX + 7.5 * sc, shoulderY + 2 * sc);
      ctx.lineTo(hipX + 15 * sc, hipY - 7 * sc);
      ctx.stroke();

      // 5. 3D Helmet & Goggles
      ctx.fillStyle = isGhost ? '#fbbf24' : '#22d3ee';
      ctx.beginPath();
      ctx.arc(shoulderX, shoulderY - 4.5 * sc, 5.8 * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = '#020617';
      ctx.fillRect(
        shoulderX - 4 * sc,
        shoulderY - 6 * sc,
        8 * sc,
        3 * sc
      );

      // 6. Floating 3D Telemetry Callout
      ctx.globalAlpha = 1.0;
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width + 12;
      let tagY = Math.max(20, shoulderY - 22 * sc);
      if (avoidY !== undefined && Math.abs(tagY - avoidY) < 21) {
        tagY = Math.max(18, avoidY - 21);
      }
      const tagX = Math.max(tw * 0.5 + 8, Math.min(W - tw * 0.5 - 8, shoulderX));

      ctx.fillStyle = isGhost
        ? 'rgba(69, 26, 3, 0.92)'
        : 'rgba(8, 51, 68, 0.92)';
      ctx.beginPath();
      ctx.roundRect(tagX - tw * 0.5, tagY - 9, tw, 18, 4);
      ctx.fill();
      ctx.strokeStyle = isGhost ? '#f59e0b' : '#06b6d4';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = isGhost ? '#fde68a' : '#67e8f9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tagX, tagY);

      ctx.restore();
      return tagY;
    };

    const mainLabel = `MAIN • ${athleteAName.split(' ').pop()?.toUpperCase()} (${Math.round(spatialSampleA.speedKmh)} km/h)`;
    const ghostLabel = `GHOST • ${athleteBName.split(' ').pop()?.toUpperCase()} (${Math.round(spatialSampleB.speedKmh)} km/h)`;

    // Painter's algorithm: draw further-downhill skier first, closer-uphill skier second
    if (aheadMB >= aheadMA) {
      const gY = draw3DSkierAvatar(
        ptB.lineOffsetB,
        aheadMB,
        ptB.curvature,
        spatialSampleB.speedKmh,
        ghostLabel,
        true
      );
      draw3DSkierAvatar(
        ptA.lineOffsetA,
        aheadMA,
        ptA.curvature,
        spatialSampleA.speedKmh,
        mainLabel,
        false,
        gY
      );
    } else {
      const mY = draw3DSkierAvatar(
        ptA.lineOffsetA,
        aheadMA,
        ptA.curvature,
        spatialSampleA.speedKmh,
        mainLabel,
        false
      );
      draw3DSkierAvatar(
        ptB.lineOffsetB,
        aheadMB,
        ptB.curvature,
        spatialSampleB.speedKmh,
        ghostLabel,
        true,
        mY
      );
    }

    // Top-Left 3D Slope Telemetry HUD Overlay
    ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
    ctx.beginPath();
    ctx.roundRect(8, 8, 255, 38, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.fillText(
      `3D SLOPE TWIN • ALT ${Math.round(ptA.wz)}m • PITCH ${Math.round(ptA.pitchPct)}%`,
      15,
      21
    );
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9.5px "JetBrains Mono", monospace';
    ctx.fillText(
      `Pos: ${Math.round(temporalSampleA.distanceMeters)}m / ${Math.round(totalLen)}m (Drag to orbit)`,
      15,
      36
    );
  }, [
    viewMode,
    spine3D,
    temporalSampleA,
    temporalSampleB,
    spatialSampleA,
    spatialSampleB,
    spatialGapMeters,
    ghostDeltaSec,
    athleteAName,
    athleteBName,
    course,
    chaseYawDeg,
  ]);

  // 2. Render 3D Isometric Full-Mountain Speed & Elevation Map (Auto-fitted to canvas bounds)
  useEffect(() => {
    if (viewMode === 'CHASE_3D') return;
    const canvas = mountainCanvasRef.current;
    if (!canvas || spine3D.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#020617');
    bgGrad.addColorStop(1, '#090d16');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    const minElev = spine3D[spine3D.length - 1].wz;
    const maxElev = spine3D[0].wz;
    const elevRange = Math.max(100, maxElev - minElev);

    const yawRad = (mountainYawDeg * Math.PI) / 180;
    const pitchRad = (mountainPitchDeg * Math.PI) / 180;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);
    const cosP = Math.cos(pitchRad);
    const sinP = Math.sin(pitchRad);

    const rawIso = (wx: number, wy: number, elevM: number, extraH = 0) => {
      const zNorm = (elevM - minElev) / elevRange + extraH;
      const rx = wx * cosY - wy * sinY;
      const ry = wx * sinY + wy * cosY;
      return {
        u: rx * 1.15,
        v: ry * cosP * 0.85 - zNorm * sinP * 1.1,
      };
    };

    // Compute auto-fit bounding box across the 3D trail and base floor
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < spine3D.length; i += 10) {
      const pt = spine3D[i];
      for (const z of [minElev, pt.wz + elevRange * 0.25]) {
        const uv = rawIso(pt.wx, pt.wy, z);
        if (uv.u < minU) minU = uv.u;
        if (uv.u > maxU) maxU = uv.u;
        if (uv.v < minV) minV = uv.v;
        if (uv.v > maxV) maxV = uv.v;
      }
    }

    const padX = 44;
    const padTop = 28;
    const padBottom = 30;
    const availW = Math.max(100, W - padX * 2);
    const availH = Math.max(80, H - padTop - padBottom);
    const spanU = Math.max(0.2, maxU - minU);
    const spanV = Math.max(0.2, maxV - minV);
    const fitScale = Math.min(availW / spanU, availH / spanV);
    const midU = (minU + maxU) * 0.5;
    const midV = (minV + maxV) * 0.5;

    const projectIso3D = (
      wx: number,
      wy: number,
      elevM: number,
      extraHeightNorm = 0
    ): { sx: number; sy: number } => {
      const uv = rawIso(wx, wy, elevM, extraHeightNorm);
      return {
        sx: W * 0.5 + (uv.u - midU) * fitScale,
        sy: padTop + availH * 0.5 + (uv.v - midV) * fitScale,
      };
    };

    // 1. Draw 3D Base Mountain Floor Grid
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.5)';
    ctx.lineWidth = 1;
    for (let g = -1.0; g <= 1.0; g += 0.5) {
      const p1 = projectIso3D(g, -1.0, minElev);
      const p2 = projectIso3D(g, 1.0, minElev);
      ctx.beginPath();
      ctx.moveTo(p1.sx, p1.sy);
      ctx.lineTo(p2.sx, p2.sy);
      ctx.stroke();

      const q1 = projectIso3D(-1.0, g, minElev);
      const q2 = projectIso3D(1.0, g, minElev);
      ctx.beginPath();
      ctx.moveTo(q1.sx, q1.sy);
      ctx.lineTo(q2.sx, q2.sy);
      ctx.stroke();
    }

    // 2. Draw 3D Elevation Drop Curtain & Vertical Terrain Pillars
    const projected: Array<{
      s: number;
      sx: number;
      sy: number;
      floorX: number;
      floorY: number;
    }> = [];
    for (let i = 0; i < spine3D.length; i += 4) {
      const pt = spine3D[i];
      const top = projectIso3D(pt.wx, pt.wy, pt.wz);
      const flr = projectIso3D(pt.wx, pt.wy, minElev);
      projected.push({
        s: pt.s,
        sx: top.sx,
        sy: top.sy,
        floorX: flr.sx,
        floorY: flr.sy,
      });
    }
    projectedMountainPointsRef.current = projected.map((p) => ({
      s: p.s,
      sx: p.sx,
      sy: p.sy,
    }));

    ctx.fillStyle = 'rgba(14, 165, 233, 0.1)';
    ctx.beginPath();
    if (projected.length > 0) {
      ctx.moveTo(projected[0].floorX, projected[0].floorY);
      for (const p of projected) {
        ctx.lineTo(p.sx, p.sy);
      }
      for (let i = projected.length - 1; i >= 0; i--) {
        ctx.lineTo(projected[i].floorX, projected[i].floorY);
      }
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i < projected.length; i += 8) {
      const p = projected[i];
      ctx.beginPath();
      ctx.moveTo(p.floorX, p.floorY);
      ctx.lineTo(p.sx, p.sy);
      ctx.stroke();
    }

    // 3. Draw 3D Speed Heatmap Ribbon & Vertical Speed Wall
    for (let i = 1; i < projected.length; i++) {
      const p0 = projected[i - 1];
      const p1 = projected[i];
      const spPt = spine3D[Math.min(spine3D.length - 1, i * 4)];
      const spdColor = speedToColor(spPt.speedA, 0.96);

      const h0 = Math.max(0.02, (spine3D[(i - 1) * 4].speedA - 55) / 420);
      const h1 = Math.max(0.02, (spPt.speedA - 55) / 420);
      const w0 = projectIso3D(
        spine3D[(i - 1) * 4].wx,
        spine3D[(i - 1) * 4].wy,
        spine3D[(i - 1) * 4].wz,
        h0
      );
      const w1 = projectIso3D(spPt.wx, spPt.wy, spPt.wz, h1);

      ctx.fillStyle = speedToColor(spPt.speedA, 0.26);
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.lineTo(w0.sx, w0.sy);
      ctx.lineTo(w1.sx, w1.sy);
      ctx.lineTo(p1.sx, p1.sy);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = spdColor;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.lineTo(p1.sx, p1.sy);
      ctx.stroke();
    }

    // 4. Draw Summit Start & Finish Labels
    if (projected.length > 1) {
      const startP = projected[0];
      const endP = projected[projected.length - 1];
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'left';
      ctx.fillText(`START ${Math.round(maxElev)}m`, startP.sx + 7, startP.sy - 4);
      ctx.fillStyle = '#10b981';
      ctx.fillText(`FINISH ${Math.round(minElev)}m`, endP.sx + 7, endP.sy + 4);
    }

    // 5. Draw 3D Active Skier Beacons
    const idxA = Math.min(
      spine3D.length - 1,
      Math.round(temporalSampleA.normalizedProgress * (spine3D.length - 1))
    );
    const idxB = Math.min(
      spine3D.length - 1,
      Math.round(temporalSampleB.normalizedProgress * (spine3D.length - 1))
    );
    const ptA = spine3D[idxA];
    const ptB = spine3D[idxB];

    const scrB = projectIso3D(ptB.wx, ptB.wy, ptB.wz);
    const scrBTop = projectIso3D(ptB.wx, ptB.wy, ptB.wz, 0.22);
    const scrA = projectIso3D(ptA.wx, ptA.wy, ptA.wz);
    const scrATop = projectIso3D(ptA.wx, ptA.wy, ptA.wz, 0.28);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scrB.sx, scrB.sy);
    ctx.lineTo(scrBTop.sx, scrBTop.sy);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(scrB.sx, scrB.sy, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(scrA.sx, scrA.sy);
    ctx.lineTo(scrATop.sx, scrATop.sy);
    ctx.stroke();

    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(scrA.sx, scrA.sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Floating 3D Pin Callouts
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    const labelA = `${athleteAName.split(' ').pop()?.toUpperCase()} ${Math.round(spatialSampleA.speedKmh)} km/h`;
    const wA = ctx.measureText(labelA).width + 10;
    const aTagX = Math.max(wA * 0.5 + 6, Math.min(W - wA * 0.5 - 6, scrATop.sx));
    ctx.fillStyle = 'rgba(8, 51, 68, 0.92)';
    ctx.beginPath();
    ctx.roundRect(aTagX - wA * 0.5, scrATop.sy - 16, wA, 16, 4);
    ctx.fill();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#67e8f9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelA, aTagX, scrATop.sy - 8);

    const labelB = `GHOST ${Math.round(spatialSampleB.speedKmh)} km/h`;
    const wB = ctx.measureText(labelB).width + 10;
    const bTagX = Math.max(wB * 0.5 + 6, Math.min(W - wB * 0.5 - 6, scrBTop.sx));
    const bTagY =
      Math.abs(scrBTop.sy - scrATop.sy) < 18
        ? scrBTop.sy + 8
        : scrBTop.sy - 16;
    ctx.fillStyle = 'rgba(69, 26, 3, 0.92)';
    ctx.beginPath();
    ctx.roundRect(bTagX - wB * 0.5, bTagY, wB, 16, 4);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.fillText(labelB, bTagX, bTagY + 8);

    // Top-Left 3D Mountain Title & Bottom Speed Legend Bar
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillText(
      `3D MOUNTAIN SPEED MAP (${Math.round(maxElev)}m → ${Math.round(minElev)}m)`,
      10,
      15
    );

    const barX = 10;
    const barY = H - 14;
    const barW = 128;
    for (let i = 0; i < barW; i++) {
      const spd = 65 + (i / barW) * 65;
      ctx.fillStyle = speedToColor(spd);
      ctx.fillRect(barX + i, barY, 1.5, 5);
    }
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText('70 km/h', barX, barY - 4);
    ctx.fillText('100', barX + 50, barY - 4);
    ctx.fillText('130+ km/h', barX + 94, barY - 4);
    ctx.textAlign = 'right';
    ctx.fillText('Click trail to seek • Drag to rotate 3D', W - 10, barY + 4);
  }, [
    viewMode,
    spine3D,
    temporalSampleA,
    temporalSampleB,
    spatialSampleA,
    spatialSampleB,
    athleteAName,
    course,
    mountainYawDeg,
    mountainPitchDeg,
  ]);

  const handleMountainPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragStateRef.current = {
      active: true,
      target: 'MOUNTAIN',
      startX: e.clientX,
      startY: e.clientY,
      initYaw: mountainYawDeg,
      initPitch: mountainPitchDeg,
      moved: false,
    };
  };

  const handleMountainPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStateRef.current.active || dragStateRef.current.target !== 'MOUNTAIN')
      return;
    const dx = e.clientX - dragStateRef.current.startX;
    const dy = e.clientY - dragStateRef.current.startY;
    if (Math.hypot(dx, dy) > 4) {
      dragStateRef.current.moved = true;
    }
    setMountainYawDeg(dragStateRef.current.initYaw + dx * 0.45);
    setMountainPitchDeg(
      Math.max(14, Math.min(72, dragStateRef.current.initPitch + dy * 0.35))
    );
  };

  const handleMountainPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasMoved = dragStateRef.current.moved;
    dragStateRef.current.active = false;
    if (!wasMoved && mountainCanvasRef.current) {
      const rect = mountainCanvasRef.current.getBoundingClientRect();
      const clickX =
        ((e.clientX - rect.left) / Math.max(1, rect.width)) *
        mountainCanvasRef.current.width;
      const clickY =
        ((e.clientY - rect.top) / Math.max(1, rect.height)) *
        mountainCanvasRef.current.height;
      let bestS = temporalSampleA.normalizedProgress;
      let bestDist = Infinity;
      for (const pt of projectedMountainPointsRef.current) {
        const d = Math.hypot(pt.sx - clickX, pt.sy - clickY);
        if (d < bestDist) {
          bestDist = d;
          bestS = pt.s;
        }
      }
      if (bestDist < 42) {
        onSeekToProgress(bestS);
      }
    }
  };

  const handleChasePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragStateRef.current = {
      active: true,
      target: 'CHASE',
      startX: e.clientX,
      startY: e.clientY,
      initYaw: chaseYawDeg,
      initPitch: 0,
      moved: false,
    };
  };

  const handleChasePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStateRef.current.active || dragStateRef.current.target !== 'CHASE')
      return;
    const dx = e.clientX - dragStateRef.current.startX;
    setChaseYawDeg(
      Math.max(-38, Math.min(38, dragStateRef.current.initYaw + dx * 0.25))
    );
  };

  const handleChasePointerUp = () => {
    dragStateRef.current.active = false;
  };

  return (
    <div
      data-testid="slope-3d-reconstructor"
      className="flex h-full w-full flex-col gap-2"
    >
      {/* 3D Sub-Mode Switcher Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/90 px-2.5 py-1.5 text-[11px]">
        <div className="flex items-center gap-1">
          <button
            data-testid="3d-mode-split-btn"
            onClick={() => setViewMode('SPLIT_3D')}
            className={`rounded px-2 py-0.5 font-semibold transition ${
              viewMode === 'SPLIT_3D'
                ? 'bg-cyan-500 text-slate-950 shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            3D Slope + Speed Map
          </button>
          <button
            data-testid="3d-mode-chase-btn"
            onClick={() => setViewMode('CHASE_3D')}
            className={`rounded px-2 py-0.5 font-semibold transition ${
              viewMode === 'CHASE_3D'
                ? 'bg-cyan-500 text-slate-950 shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            3D Skier Chase-Cam
          </button>
          <button
            data-testid="3d-mode-mountain-btn"
            onClick={() => setViewMode('MOUNTAIN_3D')}
            className={`rounded px-2 py-0.5 font-semibold transition ${
              viewMode === 'MOUNTAIN_3D'
                ? 'bg-cyan-500 text-slate-950 shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            3D Mountain Map
          </button>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="text-cyan-300">
            &Delta;v:{' '}
            {spatialSampleA.speedKmh - spatialSampleB.speedKmh >= 0 ? '+' : ''}
            {(spatialSampleA.speedKmh - spatialSampleB.speedKmh).toFixed(1)} km/h
          </span>
          {(chaseYawDeg !== 0 || mountainYawDeg !== -24) && (
            <button
              onClick={() => {
                setChaseYawDeg(0);
                setMountainYawDeg(-24);
                setMountainPitchDeg(38);
              }}
              className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-slate-300 hover:text-white"
            >
              Reset 3D
            </button>
          )}
        </div>
      </div>

      {/* 3D Canvases Container */}
      <div className="flex flex-1 flex-col gap-2">
        {(viewMode === 'SPLIT_3D' || viewMode === 'CHASE_3D') && (
          <div className="relative flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
            <canvas
              ref={chaseCanvasRef}
              data-testid="chase-3d-canvas"
              width={520}
              height={viewMode === 'CHASE_3D' ? (compact ? 420 : 480) : 230}
              onPointerDown={handleChasePointerDown}
              onPointerMove={handleChasePointerMove}
              onPointerUp={handleChasePointerUp}
              className="block h-full w-full cursor-grab active:cursor-grabbing"
            />
          </div>
        )}

        {(viewMode === 'SPLIT_3D' || viewMode === 'MOUNTAIN_3D') && (
          <div className="relative flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
            <canvas
              ref={mountainCanvasRef}
              data-testid="mountain-3d-canvas"
              width={520}
              height={viewMode === 'MOUNTAIN_3D' ? (compact ? 420 : 480) : 205}
              onPointerDown={handleMountainPointerDown}
              onPointerMove={handleMountainPointerMove}
              onPointerUp={handleMountainPointerUp}
              className="block h-full w-full cursor-grab active:cursor-grabbing"
            />
          </div>
        )}
      </div>
    </div>
  );
};
