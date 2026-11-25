# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=11,<13"]
# ///
"""Render a camera-matched Beaver Creek replay from video-derived telemetry."""

import argparse
import bisect
import contextlib
import json
import math
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "public/clips/raw_pos"
TRACK_DIR = ROOT / "public/data/tracks"
FRAME_SIZE = (1920, 1080)
PANE_SIZE = (896, 504)
PANE_Y = 218
FPS = 30
BACKGROUND = "#0b111a"
PANEL = "#131e2b"
LINE = "#2d3f53"
WHITE = "#f1f6ff"
MUTED = "#a8b9c9"


@dataclass(frozen=True)
class Athlete:
    code: str
    name: str
    alias: str
    color: str
    pane_x: int


ATHLETES = (
    Athlete("RYACOC", "Ryan Cochran-Siegle", "RYAN", "#67d9f7", 48),
    Athlete("BRYBEN", "Bryce Bennett", "BRYCE", "#ffc779", 976),
)


@dataclass(frozen=True)
class Scene:
    position: int
    name: str
    native_anchor_sec: tuple[float, float]
    before_sec: float
    after_sec: float
    playback_rate: float = 1.0


SCENES = (
    Scene(1, "Start hut exit", (2.56, 2.38), 0.10, 6.10),
    Scene(2, "Red gate above the safety net", (22.76, 23.20), 2.90, 2.60),
    Scene(3, "Paired red gates above the cables", (7.08, 7.04), 3.20, 1.80),
    Scene(4, "Red gate above the foreground cable", (16.68, 16.56), 3.00, 3.00),
    Scene(5, "Carve beside the Celsius banner", (22.12, 23.06), 4.00, 0.65),
    Scene(6, "Blue stripe at the red flag", (11.04, 11.32), 2.00, 2.50),
    Scene(7, "Late-course red gate", (14.08, 14.80), 1.50, 2.50),
    Scene(8, "STIFEL arch", (7.92, 7.90), 2.10, 3.80),
)
SLOW_REPLAY = Scene(5, "Celsius gate · Half-speed replay", (22.12, 23.06), 1.75, 0.62, 0.5)


@dataclass(frozen=True)
class Sample:
    utc: float
    elapsed: float
    distance: float
    speed: float
    uncertainty: float

    def interpolate(self, other: "Sample", fraction: float) -> "Sample":
        def blend(left, right):
            return left + (right - left) * fraction

        return Sample(
            blend(self.utc, other.utc),
            blend(self.elapsed, other.elapsed),
            blend(self.distance, other.distance),
            blend(self.speed, other.speed),
            max(self.uncertainty, other.uncertainty),
        )


@dataclass(frozen=True)
class TimeSpan:
    source: str
    start_video: float
    end_video: float
    start_utc: float
    end_utc: float

    def to_utc(self, video: float) -> float:
        fraction = (video - self.start_video) / (self.end_video - self.start_video)
        return self.start_utc + fraction * (self.end_utc - self.start_utc)

    def to_video(self, utc: float) -> float:
        fraction = (utc - self.start_utc) / (self.end_utc - self.start_utc)
        return self.start_video + fraction * (self.end_video - self.start_video)


class Run:
    def __init__(self, data):
        self.spans = tuple(TimeSpan(
            clip["source"], clip["start_video_s"], clip["end_video_s"],
            clip["start_utc_s"], clip["end_utc_s"],
        ) for clip in data["clips"])
        self.samples = tuple(Sample(
            point["utc_s"], point["run_elapsed_s"], point["distance_m"],
            point["speed_kmh"], point["estimate_uncertainty_kmh"],
        ) for point in data["samples"])
        self.landmarks = {point["name"]: point for point in data["landmarks"]}
        self.times = tuple(point.utc for point in self.samples)
        self.distances = tuple(point.distance for point in self.samples)
        if any(a >= b for a, b in zip(self.times, self.times[1:])):
            raise ValueError("Telemetry samples must have strictly increasing timestamps")
        if any(a > b for a, b in zip(self.distances, self.distances[1:])):
            raise ValueError("Telemetry distance must be monotonically increasing")

    def sample_at(self, axis: tuple[float, ...], value: float) -> Sample | None:
        index = bisect.bisect_left(axis, value)
        if index < len(axis) and math.isclose(axis[index], value, abs_tol=0.0005, rel_tol=0):
            return self.samples[index]
        if index == 0 or index == len(axis):
            return None
        before, after = self.samples[index - 1:index + 1]
        if after.utc - before.utc > 0.25:
            return None
        fraction = (value - axis[index - 1]) / (axis[index] - axis[index - 1])
        return before.interpolate(after, fraction)

    def at_video(self, source: str, second: float) -> Sample | None:
        for span in self.spans:
            if span.source == source and span.start_video <= second <= span.end_video:
                return self.sample_at(self.times, span.to_utc(second))
        return None

    def at_distance(self, distance: float) -> Sample | None:
        return self.sample_at(self.distances, distance)

    def video_at(self, source: str, utc: float) -> float | None:
        for span in self.spans:
            if span.source == source and span.start_utc <= utc <= span.end_utc:
                return span.to_video(utc)
        return None


@dataclass(frozen=True)
class FramePlan:
    video_times: tuple[float, float]
    samples: tuple[Sample | None, Sample | None]
    course_distance: float | None
    landmark_sec: float
    alignment: str


def scene_frames(scene: Scene, sources: tuple[str, str], runs: tuple[Run, Run]):
    anchors = tuple(run.at_video(source, sec) for run, source, sec in zip(
        runs, sources, scene.native_anchor_sec,
    ))
    shift = anchors[1].distance - anchors[0].distance if all(anchors) else None
    landmark_frames = []
    distance_frames = []
    frame_count = round((scene.before_sec + scene.after_sec) / scene.playback_rate * FPS)
    for idx in range(frame_count):
        offset = idx / FPS * scene.playback_rate - scene.before_sec
        native_a, native_b = (sec + offset for sec in scene.native_anchor_sec)
        sample_a = runs[0].at_video(sources[0], native_a)
        sample_b = runs[1].at_video(sources[1], native_b)
        distance_a = sample_a.distance if sample_a else None
        landmark_frames.append(FramePlan((native_a, native_b), (sample_a, sample_b), distance_a,
                                         offset, "LANDMARK REPLAY"))
        if sample_a is not None and shift is not None:
            aligned = runs[1].at_distance(sample_a.distance + shift)
            aligned_b = runs[1].video_at(sources[1], aligned.utc) if aligned else None
            if aligned_b is not None and -0.42 < aligned_b - native_b < 0.42:
                distance_frames.append(FramePlan(
                    (native_a, aligned_b), (sample_a, aligned), distance_a,
                    offset, "COURSE-ALIGNED REPLAY",
                ))
    if len(distance_frames) == frame_count and all(
        first.video_times[1] <= second.video_times[1]
        for first, second in zip(distance_frames, distance_frames[1:])
    ):
        return distance_frames
    return landmark_frames


class VideoFrames:
    def __init__(self, source: Path, start: float, end: float):
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=avg_frame_rate", "-of", "json", str(source),
        ], text=True))
        self.fps = Fraction(probe["streams"][0]["avg_frame_rate"])
        self.index = max(0, math.floor(start * self.fps) - 2)
        seek = max(0, self.index / self.fps - 0.001)
        frame_count = round(end * self.fps) - self.index + 1
        self.process = subprocess.Popen([
            "ffmpeg", "-nostdin", "-v", "error", "-threads", "3", "-ss", f"{seek:.6f}",
            "-i", str(source), "-map", "0:v:0", "-an", "-filter_threads", "2",
            "-vf", f"scale={PANE_SIZE[0]}:{PANE_SIZE[1]}", "-fps_mode", "passthrough",
            "-frames:v", str(frame_count), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ], stdout=subprocess.PIPE)
        self.image = self.read()

    def read(self) -> Image.Image:
        size = math.prod(PANE_SIZE) * 3
        raw = self.process.stdout.read(size)
        if len(raw) != size:
            raise RuntimeError(f"Source stopped at frame {self.index}")
        return Image.frombytes("RGB", PANE_SIZE, raw)

    def at(self, second: float) -> tuple[Image.Image, float]:
        wanted = round(second * self.fps)
        if wanted < self.index:
            raise RuntimeError("Replay requested a non-monotonic video timestamp")
        while self.index < wanted:
            self.index += 1
            self.image = self.read()
        return self.image, self.index / self.fps

    def close(self):
        self.process.stdout.close()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait()


class Track:
    def __init__(self, source: str, directory: Path):
        path = directory / f"{source}.json"
        data = json.loads(path.read_text())
        if data["version"] != 1 or data["source"] != source:
            raise ValueError(f"Incorrect annotation track for {source}")
        self.fps = Fraction(data["fpsNumerator"], data["fpsDenominator"])
        self.start = data["startFrame"]
        self.points = data["tracks"]

    def at(self, second: float) -> tuple[float, float, float, float] | None:
        frame = round(second * self.fps) - self.start
        return self.points[frame] if 0 <= frame < len(self.points) else None


@lru_cache(maxsize=None)
def font(size: int, style: str = "regular"):
    mac_fonts = {
        "regular": ("/System/Library/Fonts/Avenir Next.ttc", 7),
        "bold": ("/System/Library/Fonts/Avenir Next.ttc", 0),
        "mono": ("/System/Library/Fonts/SFNSMono.ttf", 0),
    }
    mac_path, index = mac_fonts[style]
    if Path(mac_path).exists():
        return ImageFont.truetype(mac_path, size, index=index)
    linux_fonts = {"regular": "DejaVuSans.ttf", "bold": "DejaVuSans-Bold.ttf", "mono": "DejaVuSansMono.ttf"}
    try:
        return ImageFont.truetype(linux_fonts[style], size)
    except OSError:
        return ImageFont.load_default(size)


def text(draw, xy, value, size, color=WHITE, style="regular", anchor="lt"):
    draw.text(xy, value, fill=color, font=font(size, style), anchor=anchor)


def clock(elapsed: float) -> str:
    tenths = round(max(0, elapsed) * 10)
    return f"{tenths // 600}:{tenths % 600 // 10:02d}.{tenths % 10}"


def overlay_marker(draw, athlete: Athlete, box):
    if box is None:
        return
    cx, cy, _, height = box
    x = round(athlete.pane_x + cx * PANE_SIZE[0])
    y = round(PANE_Y + cy * PANE_SIZE[1])
    radius = 9
    marker_width = 86
    label_x = max(athlete.pane_x + 13, min(
        x + 27, athlete.pane_x + PANE_SIZE[0] - marker_width - 13,
    ))
    label_y = max(PANE_Y + 13, min(
        y - 32 - round(height * PANE_SIZE[1] / 2), PANE_Y + PANE_SIZE[1] - 47,
    ))
    draw.line((x, y, label_x, label_y + 17), fill=BACKGROUND, width=6)
    draw.line((x, y, label_x, label_y + 17), fill=athlete.color, width=3)
    draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=BACKGROUND, outline=athlete.color, width=3)
    draw.rounded_rectangle((label_x, label_y, label_x + marker_width, label_y + 34), 7, fill=BACKGROUND, outline=athlete.color, width=2)
    text(draw, (label_x + marker_width / 2, label_y + 17), athlete.alias, 17, athlete.color, "bold", "mm")


@dataclass(frozen=True)
class Chart:
    x: int
    heading: str
    unit: str
    values: tuple[tuple[float, float], ...]
    course_length: float
    scale: float

    def point(self, distance: float, value: float) -> tuple[int, int]:
        return round(self.x + 48 + distance / self.course_length * 806), round(883 - 54 * value / self.scale)

    def plot(self, draw):
        draw.rounded_rectangle((self.x, 756, self.x + 896, 988), 10, fill=PANEL, outline=LINE)
        text(draw, (self.x + 21, 775), self.heading, 24, WHITE, "bold")
        draw.line((self.x + 48, 883, self.x + 854, 883), fill=LINE, width=2)
        text(draw, (self.x + 43, 824), f"+{self.scale:g}", 16, MUTED, "mono", "rt")
        text(draw, (self.x + 43, 929), f"−{self.scale:g}", 16, MUTED, "mono", "rt")
        for fraction in (0, .25, .5, .75, 1):
            x, _ = self.point(fraction * self.course_length, 0)
            draw.line((x, 826, x, 940), fill=LINE, width=1)
            value = f"{fraction * self.course_length / 1000:.1f}"
            if fraction == 1:
                text(draw, (x + 17, 951), f"{self.course_length / 1000:.2f} km", 16, MUTED, "mono", "rt")
            else:
                text(draw, (x, 951), value, 16, MUTED, "mono", "mt")
        for (a_dist, a_value), (b_dist, b_value) in zip(self.values, self.values[1:]):
            if b_dist - a_dist <= 20:
                draw.line((*self.point(a_dist, a_value), *self.point(b_dist, b_value)),
                          fill=ATHLETES[0].color if (a_value + b_value) > 0 else ATHLETES[1].color, width=4)

    def cursor(self, draw, distance: float, value: float | None):
        x, y = self.point(min(max(distance, 0), self.course_length), value or 0)
        draw.line((x, 820, x, 942), fill="#647a90", width=2)
        if value is not None:
            color = ATHLETES[0].color if value > 0 else ATHLETES[1].color
            draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=color, outline=BACKGROUND, width=2)
            text(draw, (self.x + 874, 775), f"{value:+.1f} {self.unit}", 25, color, "mono", "rt")


def charts_for(runs: tuple[Run, Run], length: float) -> tuple[Chart, Chart]:
    measured = [(distance, a.speed - b.speed, b.elapsed - a.elapsed)
                for distance in range(0, round(length), 5)
                if (a := runs[0].at_distance(distance)) is not None and (b := runs[1].at_distance(distance)) is not None]
    speed = tuple((dist, gap) for dist, gap, _ in measured)
    timing = tuple((dist, gap) for dist, _, gap in measured)
    speed_scale = max(5, math.ceil(max((abs(value) for _, value in speed), default=0) / 5) * 5)
    time_scale = max(1, math.ceil(max((abs(value) for _, value in timing), default=0)))
    return (Chart(48, "Speed gap · Ryan minus Bryce", "km/h", speed, length, speed_scale),
            Chart(976, "Time gain · Bryce minus Ryan", "s", timing, length, time_scale))


def coaching_summary(runs: tuple[Run, Run]) -> tuple[str, str, str]:
    ryan, bryce = runs
    first, second = "pos2_red_gate_by_safety_fence", "pos5_celsius_red_gate"
    if not all(landmark in run.landmarks for run in runs for landmark in (first, second)):
        return ("Compare the red gates in cameras 02 and 05.",
                "Use the same-course charts to inspect where the time gap changed.",
                "The half-speed view shows each skier’s line through the same red gate.")
    start_ryan = ryan.landmarks[first]["run_elapsed_s"]
    end_ryan = ryan.landmarks[second]["run_elapsed_s"]
    start_bryce = bryce.landmarks[first]["run_elapsed_s"]
    end_bryce = bryce.landmarks[second]["run_elapsed_s"]
    distance = ryan.landmarks[second]["distance_m"] - ryan.landmarks[first]["distance_m"]
    average_ryan = 3.6 * distance / (end_ryan - start_ryan)
    average_bryce = 3.6 * distance / (end_bryce - start_bryce)
    pace = f"Estimated average speed between those gates   Ryan {average_ryan:.1f} km/h   ·   Bryce {average_bryce:.1f} km/h"
    entry = start_ryan - start_bryce
    exit = end_bryce - end_ryan
    if entry > 0 and exit > 0:
        return (
            f"Bryce led by about {entry:.1f} s at camera 02. Ryan led by about {exit:.1f} s at camera 05.",
            pace,
            "The half-speed view shows Ryan brush the red panel as Bryce passes just below it.",
        )
    return (f"The time gap changed by about {abs(entry + exit):.1f} s between cameras 02 and 05.",
            pace,
            "The half-speed view shows both athletes’ line through the same red gate.")


def scene_chrome(scene: Scene, charts: tuple[Chart, Chart]) -> Image.Image:
    frame = Image.new("RGB", FRAME_SIZE, BACKGROUND)
    draw = ImageDraw.Draw(frame)
    text(draw, (48, 33), "BEAVER CREEK  /  BIRDS OF PREY  /  03 DEC 2025", 21, MUTED, "bold")
    text(draw, (48, 76), scene.name, 53, WHITE, "bold")
    text(draw, (1872, 38), f"CAMERA {scene.position:02d} / 08", 25, MUTED, "mono", "rt")
    for athlete in ATHLETES:
        x = athlete.pane_x
        draw.rounded_rectangle((x, 149, x + PANE_SIZE[0], PANE_Y + 10), 8, fill=PANEL)
        draw.rectangle((x, 149, x + 5, PANE_Y), fill=athlete.color)
        text(draw, (x + 22, 170), athlete.name, 31, WHITE, "bold")
    for chart in charts:
        chart.plot(draw)
    text(draw, (48, 1014), "Training runs  •  Video timecode and modeled distance  •  ± shows the estimated speed uncertainty", 21, MUTED)
    return frame


def render_frame(base: Image.Image, video_frames, tracks, plan: FramePlan, charts, runs) -> Image.Image:
    frame = base.copy()
    draw = ImageDraw.Draw(frame)
    text(draw, (1872, 86), plan.alignment, 23, WHITE, "bold", "rt")
    if abs(plan.landmark_sec) < .28:
        text(draw, (1872, 117), "SHARED LANDMARK", 17, "#9fdbb8", "bold", "rt")
    for athlete, decoder, track, sec, sample in zip(ATHLETES, video_frames, tracks, plan.video_times, plan.samples):
        image, timestamp = decoder.at(sec)
        frame.paste(image, (athlete.pane_x, PANE_Y))
        overlay_marker(draw, athlete, track.at(timestamp))
        pane_right = athlete.pane_x + PANE_SIZE[0] - 22
        if sample is None:
            text(draw, (pane_right, 178), "TIMING UNAVAILABLE", 21, MUTED, "bold", "rt")
        else:
            text(draw, (pane_right, 169), f"{sample.speed:.0f} ± {sample.uncertainty:.0f} km/h", 26, athlete.color, "mono", "rt")
            text(draw, (pane_right - 244, 171), clock(sample.elapsed), 26, WHITE, "mono", "rt")
    if plan.course_distance is not None:
        a, b = (run.at_distance(plan.course_distance) for run in runs)
        speed_gap = a.speed - b.speed if a is not None and b is not None else None
        time_gain = b.elapsed - a.elapsed if a is not None and b is not None else None
        for chart, value in zip(charts, (speed_gap, time_gain)):
            chart.cursor(draw, plan.course_distance, value)
        text(draw, (1872, 1014), f"{plan.course_distance:,.0f} m MODELED COURSE DISTANCE", 20, MUTED, "mono", "rt")
    return frame


def title_card(which: str, charts: tuple[Chart, Chart], runs: tuple[Run, Run]) -> Image.Image:
    frame = Image.new("RGB", FRAME_SIZE, BACKGROUND)
    draw = ImageDraw.Draw(frame)
    if which == "opening":
        text(draw, (96, 143), "BEAVER CREEK  /  BIRDS OF PREY", 30, MUTED, "bold")
        draw.line((96, 222, 1824, 222), fill=LINE, width=2)
        text(draw, (96, 296), "Two lines down", 128, WHITE, "bold")
        text(draw, (96, 444), "Birds of Prey", 128, WHITE, "bold")
        for athlete, x in zip(ATHLETES, (96, 940)):
            draw.rectangle((x, 691, x + 6, 768), fill=athlete.color)
            text(draw, (x + 24, 714), athlete.name, 38, athlete.color, "bold")
        text(draw, (96, 924), "Downhill training  •  03 December 2025  •  Eight course landmarks", 29, MUTED)
    else:
        text(draw, (96, 140), "BEAVER CREEK  /  BIRDS OF PREY", 30, MUTED, "bold")
        text(draw, (96, 268), "The gap down the course", 100, WHITE, "bold")
        split, pace, line_observation = coaching_summary(runs)
        text(draw, (96, 417), split, 37, WHITE)
        text(draw, (96, 493), pace, 30, WHITE)
        text(draw, (96, 561), line_observation, 28, MUTED)
        text(draw, (96, 616), "The last matched view is on the course beneath the STIFEL arch.", 28, MUTED)
        for chart in charts:
            chart.plot(draw)
    return frame


def render(args):
    data = json.loads(args.telemetry.read_text())
    telemetry_by_name = {entry["athlete"]: entry for entry in data["runs"]}
    runs = tuple(Run(telemetry_by_name[athlete.name]) for athlete in ATHLETES)
    charts = charts_for(runs, data["course"]["length_m"])
    scenes = tuple(scene for scene in SCENES if scene.position in args.positions)
    if 5 in args.positions:
        scenes += (SLOW_REPLAY,)
    duration = 8 + sum((scene.before_sec + scene.after_sec) / scene.playback_rate for scene in scenes)
    maxrate_kbps = min(8000, int(22 * (1024 ** 2) * 8 / (duration * 1000)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="comparison-", dir=args.output.parent) as directory:
        temp = Path(directory) / args.output.name
        encoder = subprocess.Popen([
            "ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
            "-video_size", f"{FRAME_SIZE[0]}x{FRAME_SIZE[1]}", "-framerate", str(FPS),
            "-i", "pipe:0", "-an", "-c:v", "libx264", "-threads", "6", "-preset", "veryfast",
            "-crf", "19", "-maxrate", f"{maxrate_kbps}k", "-bufsize", f"{maxrate_kbps}k",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temp),
        ], stdin=subprocess.PIPE)
        try:
            opening = title_card("opening", charts, runs).tobytes()
            for _ in range(3 * FPS):
                encoder.stdin.write(opening)
            for scene in scenes:
                sources = tuple(next(SOURCE_DIR.glob(f"{athlete.code}_*_POS{scene.position}.*")) for athlete in ATHLETES)
                plan = scene_frames(scene, tuple(source.name for source in sources), runs)
                chrome = scene_chrome(scene, charts)
                tracks = tuple(Track(source.name, args.tracks) for source in sources)
                track_counts = [0, 0]
                metric_counts = [0, 0]
                with contextlib.ExitStack() as owned:
                    streams = []
                    for source, start, end in zip(sources, plan[0].video_times, plan[-1].video_times):
                        reader = VideoFrames(source, start, end)
                        owned.callback(reader.close)
                        streams.append(reader)
                    for step in plan:
                        encoder.stdin.write(render_frame(chrome, streams, tracks, step, charts, runs).tobytes())
                        for index, (stream, track, sample) in enumerate(zip(streams, tracks, step.samples)):
                            track_counts[index] += track.at(stream.index / stream.fps) is not None
                            metric_counts[index] += sample is not None
                print(f"POS{scene.position} {scene.name} | {len(plan)} frames | {plan[0].alignment} | "
                      f"tracked {track_counts} | metrics {metric_counts}", flush=True)
            closing = title_card("closing", charts, runs).tobytes()
            for _ in range(5 * FPS):
                encoder.stdin.write(closing)
            encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError("ffmpeg could not encode the comparison")
            if temp.stat().st_size > 25 * 1024 ** 2:
                raise RuntimeError("The comparison video exceeds the 25 MiB site asset limit")
            temp.replace(args.output)
        finally:
            if encoder.poll() is None:
                encoder.kill()
                encoder.wait()
            with contextlib.suppress(BrokenPipeError):
                encoder.stdin.close()
    print(args.output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telemetry", type=Path, default=ROOT / "artifacts/downhill-telemetry/telemetry.json")
    parser.add_argument("--tracks", type=Path, default=TRACK_DIR)
    parser.add_argument("--output", type=Path, default=ROOT / "public/clips/downhill-comparison.mp4")
    parser.add_argument("--positions", type=int, choices=range(1, 9), nargs="+", default=range(1, 9))
    args = parser.parse_args()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        parser.error("ffmpeg and ffprobe are required")
    render(args)
