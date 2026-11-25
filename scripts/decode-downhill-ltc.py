#!/usr/bin/env python3
"""Map source video time to 25 fps UTC LTC from the left audio channel."""

import argparse
import json
import re
import shutil
import subprocess
import sys
from array import array
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile


LTC_FPS = 25
WORD_BITS = 80
SAMPLE_RATE = 48_000
FRAMES_PER_DAY = 24 * 60 * 60 * LTC_FPS
SYNC_WORD = 0xBFFC
MAX_SYNC_GAP_S = 0.8
MAX_FRAME_OFFSET_S = 0.004
MIN_SPAN_FRAMES = 5


@dataclass(frozen=True)
class LTCWord:
    video_s: float
    utc_frame: int


def bcd_field(word: int, offset: int, tens_mask: int) -> int | None:
    units = (word >> offset) & 0xF
    if units > 9:
        return None
    tens = (word >> (offset + 8)) & tens_mask
    return 10 * tens + units


def utc_frame(word: int) -> int | None:
    # The drop-frame flag is invalid for the organizer's 25 fps clock.
    if word & (1 << 10):
        return None
    hours = bcd_field(word, 48, 0x3)
    minutes = bcd_field(word, 32, 0x7)
    seconds = bcd_field(word, 16, 0x7)
    frames = bcd_field(word, 0, 0x3)
    if hours is None or minutes is None or seconds is None or frames is None:
        return None
    if hours >= 24 or minutes >= 60 or seconds >= 60 or frames >= LTC_FPS:
        return None
    return (((hours * 60) + minutes) * 60 + seconds) * LTC_FPS + frames


def decode_words(samples: array) -> list[LTCWord]:
    words = []
    word = 0
    bit_starts: deque[int] = deque(maxlen=WORD_BITS)
    previous_edge = None
    first_short_edge = None
    polarity = 0
    # Hysteresis rejects edge ringing without following fluctuations in ambient audio.
    threshold = max(96, min(400, max(max(samples, default=0), -min(samples, default=0)) // 16))
    for sample_index, sample in enumerate(samples):
        if sample > threshold and polarity <= 0:
            polarity = 1
        elif sample < -threshold and polarity >= 0:
            polarity = -1
        else:
            continue

        start = previous_edge
        previous_edge = sample_index
        if start is None:
            continue
        interval = sample_index - start
        # At 48 kHz the biphase-mark edge spacings are 12 and 24 samples.
        if 8 <= interval <= 16:
            if first_short_edge is None:
                first_short_edge = start
                continue
            bit = 1
            start = first_short_edge
        elif 19 <= interval <= 29:
            if first_short_edge is not None:
                word = 0
                bit_starts.clear()
            bit = 0
        else:
            word = 0
            bit_starts.clear()
            first_short_edge = None
            continue

        first_short_edge = None
        word = (word >> 1) | (bit << (WORD_BITS - 1))
        bit_starts.append(start)
        if len(bit_starts) == WORD_BITS and word >> 64 == SYNC_WORD:
            frame = utc_frame(word)
            if frame is not None:
                words.append(LTCWord(bit_starts[0] / SAMPLE_RATE, frame))
    return words


def supported_sequences(words: list[LTCWord]) -> list[list[LTCWord]]:
    finished = []
    active: list[list[LTCWord]] = []
    for word in words:
        recent = []
        for sequence in active:
            if word.video_s - sequence[-1].video_s > MAX_SYNC_GAP_S:
                if len(sequence) >= MIN_SPAN_FRAMES:
                    finished.append(sequence)
            else:
                recent.append(sequence)
        active = recent

        for sequence in active:
            previous = sequence[-1]
            frame_count = (word.utc_frame - previous.utc_frame) % FRAMES_PER_DAY
            video_elapsed = word.video_s - previous.video_s
            if frame_count > 0 and abs(frame_count / LTC_FPS - video_elapsed) <= MAX_FRAME_OFFSET_S:
                sequence.append(LTCWord(word.video_s, previous.utc_frame + frame_count))
                break
        else:
            active.append([word])
    return finished + [sequence for sequence in active if len(sequence) >= MIN_SPAN_FRAMES]


def fit_span(words: list[LTCWord]) -> dict | None:
    start = words[0].video_s
    end = words[-1].video_s
    mean_video = sum(word.video_s for word in words) / len(words)
    mean_utc = sum(word.utc_frame for word in words) / (len(words) * LTC_FPS)
    variance = sum((word.video_s - mean_video) ** 2 for word in words)
    covariance = sum(
        (word.video_s - mean_video) * (word.utc_frame / LTC_FPS - mean_utc) for word in words
    )
    rate = covariance / variance
    fit_start_utc = mean_utc + rate * (start - mean_video)
    fit_end_utc = mean_utc + rate * (end - mean_video)
    max_error = max(
        abs(word.utc_frame / LTC_FPS - (mean_utc + rate * (word.video_s - mean_video)))
        for word in words
    )
    if abs(rate - 1) > 0.005 or max_error > MAX_FRAME_OFFSET_S:
        return None
    return {
        "start_video_s": round(start, 6),
        "end_video_s": round(end, 6),
        "start_utc_s": round(fit_start_utc, 6),
        "end_utc_s": round(fit_end_utc, 6),
        "start_ltc": format_clock(words[0].utc_frame),
        "end_ltc": format_clock(words[-1].utc_frame),
        "decoded_frames": len(words),
        "max_fit_error_s": round(max_error, 6),
    }


def format_clock(frame: int) -> str:
    seconds, frame = divmod(frame % FRAMES_PER_DAY, LTC_FPS)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frame:02d}"


def read_media(path: Path) -> dict:
    metadata = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,start_time,duration,avg_frame_rate:format=duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True,
    )
    return json.loads(metadata.stdout)


def read_left_audio(path: Path, video_start_s: float) -> array:
    filter_graph = (
        f"pan=mono|c0=c0,asetpts=PTS-({video_start_s})/TB,"
        f"aresample={SAMPLE_RATE}:async=1:first_pts=0"
    )
    pcm = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-copyts", "-i", str(path), "-map", "0:a:0",
            "-af", filter_graph, "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
        ],
        check=True, capture_output=True,
    )
    samples = array("h")
    samples.frombytes(pcm.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def decode_clip(path: Path) -> dict:
    media = read_media(path)
    streams = media.get("streams", [])
    video = next((item for item in streams if item["codec_type"] == "video"), None)
    position = re.search(r"_POS(\d+)$", path.stem, re.IGNORECASE)
    clip = {
        "source": path.name,
        "athlete_code": path.stem.split("_")[0] if position else None,
        "position": int(position.group(1)) if position else None,
        "video_fps": video.get("avg_frame_rate") if video else None,
        "duration_s": None,
        "status": "unavailable",
        "spans": [],
    }
    duration = (video or {}).get("duration") or media.get("format", {}).get("duration")
    if duration not in (None, "N/A"):
        clip["duration_s"] = float(duration)
    if not video:
        clip["reason"] = "missing video stream"
        return clip
    if not any(item["codec_type"] == "audio" for item in streams):
        clip["reason"] = "missing audio stream"
        return clip

    start_time = video.get("start_time")
    video_start_s = float(start_time) if start_time not in (None, "N/A") else 0.0
    words = decode_words(read_left_audio(path, video_start_s))
    if clip["duration_s"] is not None:
        words = [word for word in words if word.video_s <= clip["duration_s"]]
    spans = [span for sequence in supported_sequences(words) if (span := fit_span(sequence))]
    spans.sort(key=lambda span: span["start_video_s"])
    for previous, current in zip(spans, spans[1:]):
        if previous["end_video_s"] > current["start_video_s"]:
            clip["reason"] = "overlapping incompatible clock sequences"
            return clip
    if spans:
        clip["status"] = "decoded"
        clip["spans"] = spans
    else:
        clip["reason"] = "no continuous 25 fps LTC on left audio"
    return clip


def write_output(document: dict, output: Path | None) -> None:
    if output is None:
        print(json.dumps(document, indent=2))
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", dir=output.parent, encoding="utf-8", delete=False) as handle:
        temporary_file = Path(handle.name)
    try:
        temporary_file.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        temporary_file.replace(output)
    finally:
        temporary_file.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Source video paths or directories")
    parser.add_argument("--output", type=Path, help="JSON destination. Defaults to stdout.")
    args = parser.parse_args()
    for program in ("ffmpeg", "ffprobe"):
        if not shutil.which(program):
            parser.error(f"{program} is required")

    paths = set()
    for item in args.inputs:
        if item.is_dir():
            paths.update(
                path.resolve() for path in item.iterdir()
                if path.is_file() and path.suffix.lower() in {".mp4", ".mov"}
            )
        elif item.is_file():
            paths.add(item.resolve())
        else:
            parser.error(f"{item} does not exist")
    if not paths:
        parser.error("no source videos found")
    if len(paths) != len({path.name for path in paths}):
        parser.error("source basenames must be unique")

    clips = []
    for path in sorted(paths):
        try:
            clips.append(decode_clip(path))
        except subprocess.CalledProcessError as error:
            message = error.stderr.decode(errors="replace").strip()
            parser.exit(1, f"{path}: {message}\n")
    write_output({"schema_version": 1, "ltc_fps": LTC_FPS, "clips": clips}, args.output)


if __name__ == "__main__":
    main()
