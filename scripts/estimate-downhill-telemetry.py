#!/usr/bin/env python3
"""Estimate alpine telemetry from timecoded video and validate separately against GPS."""

import argparse
from bisect import bisect_right
import csv
from dataclasses import dataclass
import json
from math import floor, isfinite, sqrt
from pathlib import Path
import re
from shutil import copyfile
from statistics import mean, median, stdev


DAY_SECONDS = 86_400
SAMPLE_HZ = 10
CSV_COLUMNS = (
    "athlete", "time_utc", "run_elapsed_s", "distance_m", "speed_kmh",
    "estimate_uncertainty_kmh", "provenance", "position", "source", "video_s",
)


def number(value, label):
    if not isinstance(value, (float, int)) or isinstance(value, bool) or not isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def utc_near(utc_s, origin):
    return origin + (utc_s - origin + DAY_SECONDS / 2) % DAY_SECONDS - DAY_SECONDS / 2


def format_utc(utc_s):
    total_ms = round(utc_s * 1_000) % (DAY_SECONDS * 1_000)
    hours, rest = divmod(total_ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, ms = divmod(rest, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{ms:03d}"


def data_at(x, xs, ys):
    idx = max(0, min(bisect_right(xs, x) - 1, len(xs) - 2))
    fraction = max(0, min(1, (x - xs[idx]) / (xs[idx + 1] - xs[idx])))
    return ys[idx] + fraction * (ys[idx + 1] - ys[idx])


@dataclass(frozen=True)
class Span:
    source: str
    position: int
    start_video_s: float
    end_video_s: float
    start_utc_s: float
    end_utc_s: float

    def utc_at(self, video_s):
        fraction = (video_s - self.start_video_s) / (self.end_video_s - self.start_video_s)
        return self.start_utc_s + fraction * (self.end_utc_s - self.start_utc_s)

    def video_at(self, utc_s):
        fraction = (utc_s - self.start_utc_s) / (self.end_utc_s - self.start_utc_s)
        return self.start_video_s + fraction * (self.end_video_s - self.start_video_s)


@dataclass(frozen=True)
class ProgressCurve:
    time: tuple
    distance: tuple
    slopes: tuple

    @classmethod
    def through(cls, pairs):
        time, distance = map(tuple, zip(*pairs))
        if len(time) < 2 or any(b <= a for a, b in zip(time, time[1:])):
            raise ValueError("Course anchors must have strictly increasing video times")
        if any(b <= a for a, b in zip(distance, distance[1:])):
            raise ValueError("Course anchors must have strictly increasing distances")
        intervals = [b - a for a, b in zip(time, time[1:])]
        rates = [(b - a) / span for a, b, span in zip(distance, distance[1:], intervals)]
        slopes = [rates[0]]
        for index in range(1, len(rates)):
            before, after = intervals[index - 1:index + 1]
            w1, w2 = 2 * after + before, after + 2 * before
            slopes.append((w1 + w2) / (w1 / rates[index - 1] + w2 / rates[index]))
        slopes.append(rates[-1])
        return cls(time, distance, tuple(slopes))

    def at(self, elapsed):
        idx = max(0, min(bisect_right(self.time, elapsed) - 1, len(self.time) - 2))
        span = self.time[idx + 1] - self.time[idx]
        u = max(0, min(1, (elapsed - self.time[idx]) / span))
        left, right = self.distance[idx:idx + 2]
        slope0, slope1 = self.slopes[idx:idx + 2]
        a = span * (slope0 + slope1) + 2 * (left - right)
        b = 3 * (right - left) - span * (2 * slope0 + slope1)
        estimate = ((a * u + b) * u + span * slope0) * u + left
        rate = max(0, ((3 * a * u + 2 * b) * u + span * slope0) / span)
        return estimate, rate


def clip_index(ltc):
    return {item["source"]: item for item in ltc["clips"]}


def spans_for(clip, metadata, origin=None):
    source = clip["source"]
    item = metadata.get(source)
    if not item or item["status"] != "decoded":
        return []
    duration = number(item["duration_s"], "clip duration")
    left = number(clip.get("visible_start_s", 0), "first visible timestamp")
    right = number(clip.get("visible_end_s", duration), "last visible timestamp")
    if not 0 <= left < right <= duration + 1e-4:
        raise ValueError(f"{source}: visibility interval is outside the video")
    spans = []
    for raw in item["spans"]:
        utc_start = utc_near(raw["start_utc_s"], origin) if origin is not None else raw["start_utc_s"]
        utc_end = utc_near(raw["end_utc_s"], utc_start)
        if utc_end <= utc_start:
            continue
        native = Span(
            source, item["position"], raw["start_video_s"], raw["end_video_s"], utc_start, utc_end,
        )
        start = max(left, native.start_video_s)
        end = min(right, native.end_video_s)
        if end > start:
            spans.append(Span(source, item["position"], start, end, native.utc_at(start), native.utc_at(end)))
    return spans


def cue_utc(cue, metadata, origin=None):
    video_s = number(cue["video_s"], "cue video timestamp")
    for span in spans_for(cue, metadata, origin):
        if span.start_video_s <= video_s <= span.end_video_s:
            return span.utc_at(video_s)
    raise ValueError(f"{cue['source']}: no decoded LTC at cue {video_s:.3f}s")


def athlete_key(name):
    return re.sub(r"[^a-z0-9]+", "", name.casefold())


def gps_data(path):
    elapsed, distance, speed, utc = [], [], [], []
    athlete = None
    with path.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            try:
                raw_seconds = row["time[ISO-UTC]"].split("T", 1)[1]
                time = int(raw_seconds[:2]) * 3_600 + int(raw_seconds[2:4]) * 60
                time += int(raw_seconds[4:6]) + float(f"0.{raw_seconds[6:]}")
                values = (float(row["run-elapsed_time[s]"]), float(row["distance[m]"]), float(row["speed[km/h]"]), time)
                name = " ".join(row["athlete"].split())
            except (KeyError, ValueError, IndexError):
                continue
            if not name or not all(isfinite(value) for value in values) or (elapsed and values[0] <= elapsed[-1]):
                continue
            athlete = name
            elapsed.append(values[0])
            distance.append(values[1])
            speed.append(values[2])
            utc.append(utc_near(values[3], utc[0]) if utc else values[3])
    if not athlete or len(elapsed) < 2 or distance[-1] <= distance[0]:
        raise ValueError(f"{path}: expected a usable GPS track")
    return {"athlete": athlete, "elapsed": elapsed, "distance": distance, "speed": speed, "utc": utc}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        stream.write("\n")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def train(args):
    data = [gps_data(path) for path in args.gps]
    keys = [athlete_key(track["athlete"]) for track in data]
    if len(set(keys)) != len(keys):
        raise ValueError("Each training athlete must occur only once")
    phase = [i / 20 for i in range(21)]
    distances, speeds = [], []
    for track in data:
        times = track["elapsed"]
        metres = track["distance"]
        duration = times[-1] - times[0]
        length = metres[-1] - metres[0]
        times = [(point - times[0]) / duration for point in times]
        distances.append([(data_at(p, times, metres) - metres[0]) / length for p in phase])
        speeds.append([data_at(p, times, track["speed"]) * duration / (3.6 * length) for p in phase])
    reference = [median(values) for values in zip(*distances)]
    figure = {"phase": phase, "progress": reference, "speed_spread": [stdev(values) if len(values) > 1 else 0.15 for values in zip(*speeds)]}
    ProgressCurve.through(list(zip(phase, reference)))
    figure["training_athletes"] = [track["athlete"] for track in data]
    figure["landmarks"] = {}
    if args.annotations:
        if not args.ltc:
            raise ValueError("Training landmark annotations require --ltc")
        refs = read_json(args.annotations)
        metadata = clip_index(read_json(args.ltc))
        figure["landmark_course"] = refs["course"]
        observations = {}
        for run in refs["runs"]:
            key = athlete_key(run["athlete"])
            if key not in keys:
                continue
            gps = data[keys.index(key)]
            start = cue_utc(run["start"], metadata)
            for mark in run.get("landmarks", []):
                moment = cue_utc(mark, metadata, start) - start + gps["elapsed"][0]
                if gps["elapsed"][0] <= moment <= gps["elapsed"][-1]:
                    metres = data_at(moment, gps["elapsed"], gps["distance"])
                    observations.setdefault(mark["name"], []).append(metres)
        figure["landmarks"] = {name: {"distance_m": median(values), "support": len(values)} for name, values in observations.items()}
    write_json(args.output, figure)


def baseline_profile(course):
    grade = (course["start_altitude_m"] - course["finish_altitude_m"]) / course["length_m"]
    phase = [i / 20 for i in range(21)]
    acceleration_share = max(0.12, min(0.30, 0.30 - grade / 3))
    weight = max(0.03, min(0.10, 0.13 - grade / 6))
    distance = [(u - weight * (1 - (1 - u) ** (1 / acceleration_share))) / (1 - weight) for u in phase]
    return {"phase": phase, "progress": distance, "speed_spread": [0.25] * len(phase), "landmarks": {}, "training_athletes": []}


def estimate_curve(duration, length, landmarks, prior):
    anchors = [(0.0, 0.0), *landmarks, (duration, length)]
    points = []
    for (time0, distance0), (time1, distance1) in zip(anchors, anchors[1:]):
        phase0 = data_at(distance0 / length, prior["progress"], prior["phase"])
        phase1 = data_at(distance1 / length, prior["progress"], prior["phase"])
        if time1 <= time0 or phase1 <= phase0:
            raise ValueError("Video landmark order contradicts calibrated course order")
        points.append((time0, distance0))
        for phase, progress in zip(prior["phase"], prior["progress"]):
            if phase0 + 1e-6 < phase < phase1 - 1e-6:
                elapsed = time0 + (phase - phase0) / (phase1 - phase0) * (time1 - time0)
                points.append((elapsed, progress * length))
    points.append(anchors[-1])
    return ProgressCurve.through(points)


def run_telemetry(run, metadata, course, prior):
    name = run["athlete"]
    length = course["length_m"]
    sources = {clip["source"] for clip in run["clips"]}
    cues = [run["start"], *run.get("landmarks", [])]
    if run.get("finish"):
        cues.append(run["finish"])
    for cue in cues:
        if cue["source"] not in sources:
            raise ValueError(f"{name}: video cue refers to a source outside the run")
    start = cue_utc(run["start"], metadata)
    start_uncertainty = number(run["start"].get("uncertainty_s", 0.15), "start uncertainty")
    spans = sorted(
        (span for clip in run["clips"] for span in spans_for(clip, metadata, start)),
        key=lambda span: (span.start_utc_s, span.position),
    )
    if not spans:
        raise ValueError(f"{name}: none of its clips have usable LTC coverage")
    resolved = []
    for mark in run.get("landmarks", []):
        inherited = prior["landmarks"].get(mark["name"], {})
        distance = mark.get("distance_m", inherited.get("distance_m"))
        if distance is not None:
            elapsed = cue_utc(mark, metadata, start) - start
            distance = number(distance, "landmark distance")
            if not 0 < distance < length or elapsed <= 0:
                raise ValueError(f"{name}: landmark {mark['name']} is outside the run")
            uncertainty = number(mark.get("uncertainty_s", 0.15), "landmark uncertainty")
            resolved.append((elapsed, distance, mark["name"], uncertainty))
    resolved.sort()
    if run.get("finish"):
        finish = cue_utc(run["finish"], metadata, start)
        finish_kind = "observed_video_cue"
    elif resolved:
        elapsed, distance, _, _ = resolved[-1]
        phase = data_at(distance / length, prior["progress"], prior["phase"])
        finish = start + elapsed / phase
        finish_kind = "inferred_from_calibrated_landmark"
    else:
        raise ValueError(f"{name}: provide a visible finish or a landmark with calibrated distance")
    duration = finish - start
    if not 0 < duration < 600:
        raise ValueError(f"{name}: invalid start/finish difference {duration:.2f}s")
    curve = estimate_curve(duration, length, [(t, d) for t, d, _, _ in resolved], prior)
    source_kind = "trained_progress_prior" if prior["training_athletes"] else "course_scale_prior"
    point_provenance = f"estimated_from_video_ltc_and_{source_kind}"
    samples = []
    remaining = sorted(spans, key=lambda item: item.start_utc_s)
    active = []
    next_span = 0
    for tick in range(floor(duration * SAMPLE_HZ + 1e-6) + 1):
        elapsed = tick / SAMPLE_HZ
        utc = start + elapsed
        while next_span < len(remaining) and remaining[next_span].start_utc_s <= utc:
            active.append(remaining[next_span])
            next_span += 1
        active = [span for span in active if span.end_utc_s >= utc]
        if not active:
            continue
        chosen = max(active, key=lambda item: min(utc - item.start_utc_s, item.end_utc_s - utc))
        distance, metres_per_sec = curve.at(elapsed)
        spread = data_at(elapsed / duration, prior["phase"], prior["speed_spread"])
        uncertainty = max(4.0, spread * length / duration * 3.6)
        if finish_kind != "observed_video_cue":
            uncertainty = max(uncertainty, 6.0)
        samples.append({
            "athlete": name, "time_utc": format_utc(utc), "utc_s": round(utc, 3),
            "run_elapsed_s": elapsed, "distance_m": round(distance, 3),
            "speed_kmh": round(3.6 * metres_per_sec, 3), "estimate_uncertainty_kmh": round(uncertainty, 1),
            "provenance": point_provenance, "source": chosen.source, "position": chosen.position,
            "video_s": round(chosen.video_at(utc), 4),
        })
    if not samples:
        raise ValueError(f"{name}: no overlap between run and recorded LTC coverage")
    return {
        "athlete": name, "start_utc_s": round(start, 4), "finish_utc_s": round(finish, 4),
        "total_elapsed_s": round(duration, 4), "finish_kind": finish_kind,
        "start_kind": "observed_video_cue", "start_uncertainty_s": start_uncertainty,
        "clips": [vars(span) for span in spans], "samples": samples,
        "landmarks": [{"name": label, "run_elapsed_s": round(t, 4), "distance_m": round(d, 3),
                       "uncertainty_s": uncertainty} for t, d, label, uncertainty in resolved],
    }


def analyze(args):
    config = read_json(args.annotations)
    course = {key: number(config["course"][key], key) for key in ("length_m", "start_altitude_m", "finish_altitude_m")}
    if course["length_m"] <= 0 or not 0 < course["start_altitude_m"] - course["finish_altitude_m"] <= course["length_m"]:
        raise ValueError("Public course length and start/finish elevation must describe a descent")
    metadata = clip_index(read_json(args.ltc))
    prior = read_json(args.prior) if args.prior else baseline_profile(course)
    if prior["landmarks"] and any(prior["landmark_course"][key] != value for key, value in course.items()):
        raise ValueError("Named-landmark calibration belongs to a different course")
    args.output.mkdir(parents=True, exist_ok=True)
    runs = [run_telemetry(run, metadata, course, prior) for run in config["runs"]]
    keys = [athlete_key(run["athlete"]) for run in runs]
    if not runs or not all(keys) or len(set(keys)) != len(keys):
        raise ValueError("Analysis needs distinct athlete names")
    for run, key in zip(runs, keys):
        with (args.output / f"{key}.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            writer.writerows(run["samples"])
    payload = {"version": 1, "sample_hz": SAMPLE_HZ, "course": course, "runs": runs,
               "training_athletes": prior["training_athletes"],
               "uncertainty_note": "Heuristic speed estimate; not a calibrated prediction interval."}
    write_json(args.output / "telemetry.json", payload)


def errors_at(samples, times, reference, key, time_key):
    errors = []
    for sample in samples:
        time = sample[time_key]
        if time_key == "utc_s":
            time = utc_near(time, times[0])
        if times[0] <= time <= times[-1]:
            errors.append(sample[key] - data_at(time, times, reference))
    if not errors:
        return {"matched_rows": 0}
    return {"matched_rows": len(errors), "bias": round(mean(errors), 3),
            "mae": round(mean(map(abs, errors)), 3), "rmse": round(sqrt(mean(e * e for e in errors)), 3)}


def validate(args):
    estimate = read_json(args.estimates)
    runs = {athlete_key(run["athlete"]): run for run in estimate["runs"]}
    training = {athlete_key(name) for name in estimate["training_athletes"]}
    report = {"training_athletes": estimate["training_athletes"], "holdout": []}
    for path in args.gps:
        gps = gps_data(path)
        key = athlete_key(gps["athlete"])
        if key in training:
            raise ValueError(f"{gps['athlete']}: training athlete cannot be a holdout")
        if key not in runs:
            raise ValueError(f"{gps['athlete']}: no estimated run")
        run = runs[key]
        elapsed = gps["elapsed"]
        utc = gps["utc"]
        stats = {"athlete": run["athlete"], "video_rows": len(run["samples"]),
                 "video_minus_gps_start_utc_s": round(utc_near(run["start_utc_s"], utc[0]) - utc[0], 3),
                 "elapsed_duration_error_s": round(run["total_elapsed_s"] - (elapsed[-1] - elapsed[0]), 3),
                 "finish_kind": run["finish_kind"], "elapsed_aligned": {}, "utc_aligned": {}}
        for key, reference in (("distance_m", gps["distance"]), ("speed_kmh", gps["speed"])):
            stats["elapsed_aligned"][key] = errors_at(run["samples"], elapsed, reference, key, "run_elapsed_s")
            stats["utc_aligned"][key] = errors_at(run["samples"], utc, reference, key, "utc_s")
        report["holdout"].append(stats)
    write_json(args.output, report)


def sector_coverage(run, start, end):
    expected = floor(end * SAMPLE_HZ) - floor(start * SAMPLE_HZ)
    present = sum(start < row["run_elapsed_s"] <= end for row in run["samples"])
    return round(min(1.0, present / max(1, expected)), 3)


def comparison_for(run_a, run_b):
    by_name_b = {landmark["name"]: landmark for landmark in run_b["landmarks"]}
    paired_start_uncertainty = run_a["start_uncertainty_s"] + run_b["start_uncertainty_s"]
    landmarks = [{"name": "start", "distance_m": 0, "time_a_s": 0, "time_b_s": 0,
                  "gap_s": 0, "crossing_uncertainty_s": paired_start_uncertainty}]
    for mark_a in run_a["landmarks"]:
        mark_b = by_name_b.get(mark_a["name"])
        if not mark_b or abs(mark_a["distance_m"] - mark_b["distance_m"]) > 0.1:
            continue
        time_a, time_b = mark_a["run_elapsed_s"], mark_b["run_elapsed_s"]
        landmarks.append({
            "name": mark_a["name"], "distance_m": mark_a["distance_m"], "time_a_s": time_a,
            "time_b_s": time_b, "gap_s": round(time_b - time_a, 3),
            "crossing_uncertainty_s": round(mark_a["uncertainty_s"] + mark_b["uncertainty_s"], 3),
        })
    sections = []
    for left, right in zip(landmarks, landmarks[1:]):
        distance = right["distance_m"] - left["distance_m"]
        elapsed_a = right["time_a_s"] - left["time_a_s"]
        elapsed_b = right["time_b_s"] - left["time_b_s"]
        if min(distance, elapsed_a, elapsed_b) <= 0:
            continue
        sections.append({
            "from": left["name"], "to": right["name"],
            "start_m": left["distance_m"], "end_m": right["distance_m"],
            "gain_a_s": round(elapsed_b - elapsed_a, 3),
            "timing_uncertainty_s": round(left["crossing_uncertainty_s"] + right["crossing_uncertainty_s"], 3),
            "average_speed_a_kmh": round(3.6 * distance / elapsed_a, 1),
            "average_speed_b_kmh": round(3.6 * distance / elapsed_b, 1),
            "coverage_a": sector_coverage(run_a, left["time_a_s"], right["time_a_s"]),
            "coverage_b": sector_coverage(run_b, left["time_b_s"], right["time_b_s"]),
        })
    positive = [row for row in sections if row["gain_a_s"] > 0]
    negative = [row for row in sections if row["gain_a_s"] < 0]
    gain = max(positive, key=lambda row: row["gain_a_s"], default=None)
    loss = min(negative, key=lambda row: row["gain_a_s"], default=None)
    strongest = max(sections, key=lambda row: abs(row["gain_a_s"]), default=None)
    coaching = "Seek to a matched crossing to review line and turn choices."
    if strongest:
        speed_a = strongest["average_speed_a_kmh"]
        speed_b = strongest["average_speed_b_kmh"]
        faster = run_a["athlete"] if speed_a > speed_b else run_b["athlete"]
        coaching = (f"{faster} gained {abs(strongest['gain_a_s']):.2f} s between about "
                    f"{round(strongest['start_m'])} m and {round(strongest['end_m'])} m. "
                    f"The estimated sector average was {abs(speed_a - speed_b):.1f} km/h faster. "
                    "Review the two lines in that section for a coaching explanation.")
    return {
        "athlete_a": run_a["athlete"], "athlete_b": run_b["athlete"],
        "sign_convention": "Positive gaps and gains favor the first athlete.",
        "landmarks": landmarks, "sections": sections,
        "largest_gain": gain, "largest_loss": loss, "coaching_note": coaching,
    }


def publish_sample(args):
    estimate = read_json(args.estimates)
    runs = estimate["runs"]
    if len(runs) < 2:
        raise ValueError("A sample comparison requires two estimated runs")
    args.output.mkdir(parents=True, exist_ok=True)
    athletes = []
    for run in runs:
        csv_name = f"{athlete_key(run['athlete'])}.csv"
        copyfile(args.estimates.parent / csv_name, args.output / csv_name)
        athletes.append({
            "name": run["athlete"], "start_utc_s": run["start_utc_s"], "total_elapsed_s": run["total_elapsed_s"],
            "start_kind": run["start_kind"], "finish_kind": run["finish_kind"], "csv": csv_name,
        })
    copyfile(args.holdout, args.output / "holdout.json")
    write_json(args.output / "summary.json", {
        "version": 1, "course": estimate["course"], "athletes": athletes,
        "comparisons": [comparison_for(runs[0], runs[1])],
        "timing_note": "Start comes from the visible hut exit. No finish beam was verified; total time is inferred from the last shared landmark. CSV UTC is decoded directly from video audio. Holdout error is also reported relative to the visible start because the video and GPS clocks differ.",
        "uncertainty_note": "Landmark crossings are approximate frame observations. Sector distances use training-GPS calibration. The speed band is a heuristic allowance.",
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    steps = parser.add_subparsers(required=True)
    fit = steps.add_parser("train", help="freeze a progress prior from designated training GPS")
    fit.add_argument("gps", nargs="+", type=Path)
    fit.add_argument("--annotations", type=Path, help="visually marked landmarks for training athletes")
    fit.add_argument("--ltc", type=Path, help="decoded source clip LTC spans")
    fit.add_argument("--output", required=True, type=Path)
    fit.set_defaults(action=train)
    infer = steps.add_parser("analyze", help="produce a 10 Hz CSV per athlete and a video timeline")
    infer.add_argument("annotations", type=Path)
    infer.add_argument("ltc", type=Path)
    infer.add_argument("--prior", type=Path, help="optional frozen training calibration")
    infer.add_argument("--output", required=True, type=Path)
    infer.set_defaults(action=analyze)
    check = steps.add_parser("validate", help="compare estimates with excluded athlete GPS")
    check.add_argument("estimates", type=Path)
    check.add_argument("gps", nargs="+", type=Path)
    check.add_argument("--output", required=True, type=Path)
    check.set_defaults(action=validate)
    sample = steps.add_parser("publish-sample", help="copy sample results and write a coaching comparison")
    sample.add_argument("estimates", type=Path)
    sample.add_argument("holdout", type=Path)
    sample.add_argument("--output", required=True, type=Path)
    sample.set_defaults(action=publish_sample)
    args = parser.parse_args()
    try:
        args.action(args)
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"Telemetry error: {error}\n")


if __name__ == "__main__":
    main()
