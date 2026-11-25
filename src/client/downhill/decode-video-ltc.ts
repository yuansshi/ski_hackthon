import { AudioBufferSink, BlobSource, Input, MP4, QTFF, UnsupportedInputFormatError } from 'mediabunny';

export interface VideoLtcSpan {
  startVideoSec: number;
  endVideoSec: number;
  startUtcSec: number;
  endUtcSec: number;
}

export interface VideoLtc {
  durationSec: number;
  spans: readonly VideoLtcSpan[];
}

interface LtcWord {
  videoSec: number;
  utcFrame: number;
}

const LTC_FPS = 25;
const WORD_BITS = 80;
const FRAMES_PER_DAY = 24 * 60 * 60 * LTC_FPS;
const SYNC_WORD = 0xbffcn;
const MAX_SYNC_GAP_SEC = 0.8;
const MAX_FRAME_ERROR_SEC = 0.004;
const MIN_SPAN_FRAMES = 5;

function clockFrame(word: bigint): number | null {
  const field = (offset: bigint, tensMask: bigint) => {
    const units = Number((word >> offset) & 0xfn);
    const tens = Number((word >> (offset + 8n)) & tensMask);
    return units <= 9 ? 10 * tens + units : NaN;
  };
  if (word & (1n << 10n)) return null;

  const hours = field(48n, 0x3n);
  const minutes = field(32n, 0x7n);
  const seconds = field(16n, 0x7n);
  const frames = field(0n, 0x3n);
  return hours < 24 && minutes < 60 && seconds < 60 && frames < LTC_FPS
    ? ((hours * 60 + minutes) * 60 + seconds) * LTC_FPS + frames
    : null;
}

function decodeWords(samples: Float32Array, sampleRate: number, durationSec: number): LtcWord[] {
  const words: LtcWord[] = [];
  const bitStarts = new Int32Array(WORD_BITS);
  let bitCount = 0;
  let packedWord = 0n;
  let previousEdge = -1;
  let firstShortEdge = -1;
  let polarity = 0;
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const threshold = Math.max(96 / 32_768, Math.min(400 / 32_768, peak / 16));
  const sampleScale = sampleRate / 48_000;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample > threshold && polarity <= 0) polarity = 1;
    else if (sample < -threshold && polarity >= 0) polarity = -1;
    else continue;

    let start = previousEdge;
    previousEdge = index;
    if (start < 0) continue;

    const interval = (index - start) / sampleScale;
    let bit: bigint;
    // Biphase-mark LTC edges at 48 kHz are nominally 12 or 24 samples apart.
    if (interval >= 8 && interval <= 16) {
      if (firstShortEdge < 0) {
        firstShortEdge = start;
        continue;
      }
      bit = 1n;
      start = firstShortEdge;
    } else if (interval >= 19 && interval <= 29) {
      if (firstShortEdge >= 0) {
        packedWord = 0n;
        bitCount = 0;
      }
      bit = 0n;
    } else {
      packedWord = 0n;
      bitCount = 0;
      firstShortEdge = -1;
      continue;
    }

    firstShortEdge = -1;
    packedWord = (packedWord >> 1n) | (bit << 79n);
    bitStarts[bitCount % WORD_BITS] = start;
    bitCount += 1;
    if (bitCount >= WORD_BITS && packedWord >> 64n === SYNC_WORD) {
      const utcFrame = clockFrame(packedWord);
      const videoSec = bitStarts[bitCount % WORD_BITS] / sampleRate;
      if (utcFrame !== null && videoSec <= durationSec) words.push({ videoSec, utcFrame });
    }
  }
  return words;
}

function supportedSequences(words: readonly LtcWord[]): LtcWord[][] {
  const finished: LtcWord[][] = [];
  let active: LtcWord[][] = [];
  for (const word of words) {
    active = active.filter((sequence) => {
      const previous = sequence[sequence.length - 1];
      if (word.videoSec - previous.videoSec <= MAX_SYNC_GAP_SEC) return true;
      if (sequence.length >= MIN_SPAN_FRAMES) finished.push(sequence);
      return false;
    });

    const matching = active.find((sequence) => {
      const previous = sequence[sequence.length - 1];
      const frameGap = (word.utcFrame - previous.utcFrame + FRAMES_PER_DAY) % FRAMES_PER_DAY;
      const mediaGap = word.videoSec - previous.videoSec;
      return frameGap > 0 && Math.abs(frameGap / LTC_FPS - mediaGap) <= MAX_FRAME_ERROR_SEC;
    });
    if (matching) {
      const previous = matching[matching.length - 1];
      const frameGap = (word.utcFrame - previous.utcFrame + FRAMES_PER_DAY) % FRAMES_PER_DAY;
      matching.push({ videoSec: word.videoSec, utcFrame: previous.utcFrame + frameGap });
    } else {
      active.push([word]);
    }
  }
  return finished.concat(active.filter((sequence) => sequence.length >= MIN_SPAN_FRAMES));
}

function fitSpan(words: readonly LtcWord[]): VideoLtcSpan | null {
  const meanVideo = words.reduce((sum, word) => sum + word.videoSec, 0) / words.length;
  const meanUtc = words.reduce((sum, word) => sum + word.utcFrame / LTC_FPS, 0) / words.length;
  let variance = 0;
  let covariance = 0;
  for (const word of words) {
    const videoDelta = word.videoSec - meanVideo;
    variance += videoDelta ** 2;
    covariance += videoDelta * (word.utcFrame / LTC_FPS - meanUtc);
  }
  const rate = covariance / variance;
  if (Math.abs(rate - 1) > 0.005) return null;

  const utcAt = (videoSec: number) => meanUtc + rate * (videoSec - meanVideo);
  if (words.some((word) => Math.abs(word.utcFrame / LTC_FPS - utcAt(word.videoSec)) > MAX_FRAME_ERROR_SEC)) {
    return null;
  }
  const startVideoSec = words[0].videoSec;
  const endVideoSec = words[words.length - 1].videoSec;
  return { startVideoSec, endVideoSec, startUtcSec: utcAt(startVideoSec), endUtcSec: utcAt(endVideoSec) };
}

export async function decodeVideoLtc(file: File): Promise<VideoLtc> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error('This file has no video track.');
    if (!audio || await audio.getNumberOfChannels() < 2) {
      throw new Error('This clip has no stereo audio track. The LTC must be on the left channel.');
    }
    if (!await audio.canDecode()) {
      throw new Error('The browser cannot decode this clip’s audio codec. Try current Chrome or Edge.');
    }

    const durationSec = await video.computeDuration();
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('This video has no finite duration.');
    }
    const sampleRate = await audio.getSampleRate();
    const samples = new Float32Array(Math.ceil(durationSec * sampleRate));
    // AudioBufferSink retains the track timeline, including edits that delay the audio start.
    for await (const { buffer, timestamp } of new AudioBufferSink(audio).buffers(-Infinity, durationSec)) {
      if (buffer.sampleRate !== sampleRate) throw new Error('The audio sample rate changes inside this clip.');
      const offset = Math.round(timestamp * sampleRate);
      const start = Math.max(0, -offset);
      const end = Math.min(buffer.length, samples.length - offset);
      if (end > start) samples.set(buffer.getChannelData(0).subarray(start, end), offset + start);
    }

    const words = decodeWords(samples, sampleRate, durationSec);
    const spans: VideoLtcSpan[] = [];
    for (const sequence of supportedSequences(words)) {
      const span = fitSpan(sequence);
      if (span) spans.push(span);
    }
    spans.sort((first, second) => first.startVideoSec - second.startVideoSec);

    if (spans.length === 0) throw new Error('No continuous 25 fps LTC found on the left audio channel.');
    if (spans.some((span, index) => index > 0 && spans[index - 1].endVideoSec > span.startVideoSec)) {
      throw new Error('Conflicting LTC sequences overlap in this clip.');
    }
    return { durationSec, spans };
  } catch (error) {
    if (error instanceof UnsupportedInputFormatError) throw new Error('Choose an MP4 or MOV video file.');
    throw error;
  } finally {
    input.dispose();
  }
}
