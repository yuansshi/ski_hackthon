#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python>=4.10,<6", "numpy>=1.26,<3"]
# ///
import argparse
import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from tempfile import NamedTemporaryFile

import cv2
import numpy as np


@dataclass(frozen=True)
class Video:
    path: Path
    width: int
    height: int
    fps: Fraction
    frame_count: int

    @classmethod
    def open(cls, path):
        probe = subprocess.check_output([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames', '-of', 'json', str(path),
        ])
        stream = json.loads(probe)['streams'][0]
        return cls(path, stream['width'], stream['height'], Fraction(stream['avg_frame_rate']), int(stream['nb_frames']))

    def frames(self, start=0, stop=None):
        decoder = cv2.VideoCapture(str(self.path), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 2])
        stop = self.frame_count if stop is None else stop
        try:
            if not decoder.isOpened() or (start and not decoder.set(cv2.CAP_PROP_POS_FRAMES, start)):
                raise ValueError(f'Could not open {self.path} at frame {start}')
            for frame in range(start, stop):
                success, pixels = decoder.read()
                if not success or round(decoder.get(cv2.CAP_PROP_POS_FRAMES)) != frame + 1:
                    raise ValueError(f'Could not decode frame {frame} of {self.path}')
                yield frame, pixels
        finally:
            decoder.release()

    def write(self, path, boxes, cuts):
        output = {
            'version': 1,
            'source': self.path.name,
            'width': self.width,
            'height': self.height,
            'fpsNumerator': self.fps.numerator,
            'fpsDenominator': self.fps.denominator,
            'startFrame': 0,
            'cuts': sorted(set(cuts)),
            'tracks': boxes,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as temp:
            json.dump(output, temp, separators=(',', ':'))
            temp.write('\n')
        temp_path = Path(temp.name)
        temp_path.chmod(0o644)
        temp_path.replace(path)
        print(f'{self.path.name}  {sum(box is not None for box in boxes)}/{self.frame_count} tracked frames, {len(output["cuts"])} cuts')


def read_keyframes(video, path):
    data = json.loads(path.read_text())
    if data['source'] != video.path.name:
        raise ValueError(f'{path} names a different video')
    keys = {int(frame): box for frame, box in data['keyframes'].items()}
    cuts = set(data.get('cuts', []))
    if not keys or min(keys) < 0 or max(keys) >= video.frame_count:
        raise ValueError(f'Keyframes of {video.path.name} are outside its frame range')
    if any(not isinstance(frame, int) or frame <= 0 or frame >= video.frame_count for frame in cuts):
        raise ValueError(f'Invalid cut for {video.path.name}')
    for frame, box in keys.items():
        if box is None:
            continue
        if len(box) != 4 or not all(0 <= value <= 1 for value in box[:2]) or not all(0 < value <= 1 for value in box[2:]):
            raise ValueError(f'Invalid normalized box at {video.path.name} frame {frame}')
    return keys, cuts


def luma(pixels, width):
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    height = round(pixels.shape[0] * width / pixels.shape[1])
    return cv2.resize(gray, (width, height), interpolation=cv2.INTER_AREA)


def flow_step(previous, current, location, body_size, target):
    height, width = previous.shape
    x, y = location
    radius_x, radius_y = np.maximum(3, body_size * [.45, .43]).round().astype(int)
    left = max(0, round(min(x, target[0]) - radius_x - 24))
    right = min(width, round(max(x, target[0]) + radius_x + 25))
    top = max(0, round(min(y, target[1]) - radius_y - 24))
    bottom = min(height, round(max(y, target[1]) + radius_y + 25))
    previous = previous[top:bottom, left:right]
    current = current[top:bottom, left:right]
    mask = np.zeros_like(previous)
    cv2.ellipse(mask, (round(x) - left, round(y) - top), (radius_x, radius_y), 0, 0, 360, 255, -1)
    seeds = cv2.goodFeaturesToTrack(previous, 16, .02, 2, mask=mask)
    if seeds is None or len(seeds) < 2:
        return None
    moved, forward_ok, _ = cv2.calcOpticalFlowPyrLK(previous, current, seeds, None, winSize=(15, 15), maxLevel=2)
    if moved is None:
        return None
    recovered, backward_ok, _ = cv2.calcOpticalFlowPyrLK(current, previous, moved, None, winSize=(15, 15), maxLevel=2)
    if recovered is None:
        return None
    round_trip_error = np.linalg.norm((seeds - recovered)[:, 0, :], axis=1)
    good = (round_trip_error < 1.1) & forward_ok.ravel().astype(bool) & backward_ok.ravel().astype(bool)
    displacements = (moved - seeds)[good, 0, :]
    if len(displacements) < 2:
        return None
    candidate = location + np.median(displacements, axis=0)
    leash = max(5, min(24, np.linalg.norm(body_size) * .6))
    if np.linalg.norm(candidate - target) < leash and 0 <= candidate[0] < width and 0 <= candidate[1] < height:
        return candidate
    return None


def flow_centers(frames, expected_boxes):
    observed = [expected_boxes[0][:2]]
    for previous, current, expected, upcoming in zip(frames, frames[1:], expected_boxes, expected_boxes[1:]):
        location = observed[-1]
        observed.append(flow_step(previous, current, location, expected[2:], upcoming[:2]) if location is not None else None)
    return observed


def track_span(frames, left, right):
    height, width = frames[0].shape
    scale = np.array([width, height, width, height])
    expected = np.linspace(left, right, len(frames)) * scale
    forward = flow_centers(frames, expected)
    reverse = flow_centers(frames[::-1], expected[::-1])[::-1]
    for index in range(1, len(frames) - 1):
        fraction = index / (len(frames) - 1)
        left_box, right_box = forward[index], reverse[index]
        box = expected[index].copy()
        if left_box is not None and right_box is not None:
            tolerance = max(3, min(14, np.hypot(*box[2:]) * .42))
            if np.linalg.norm(left_box - right_box) <= tolerance:
                # Blend toward the stronger endpoint and attenuate corrections near the reviewed boxes.
                observed = (1 - fraction) * left_box + fraction * right_box
                box[:2] += (observed - box[:2]) * (4 * fraction * (1 - fraction))
        yield (box / scale).round(6).tolist()


def track_video(video, keyframes, output):
    keys, cuts = read_keyframes(video, keyframes)
    points = sorted(keys)
    boxes = [None] * video.frame_count
    for frame, box in keys.items():
        boxes[frame] = box
    if len(points) == 1:
        video.write(output, boxes, cuts)
        return
    maximum_gap = float(video.fps) * .44
    images = video.frames(points[0], points[-1] + 1)
    previous_pixels = luma(next(images)[1], 960)
    for left, right in zip(points, points[1:]):
        eligible = keys[left] is not None and keys[right] is not None and right - left <= maximum_gap
        eligible &= all(not left < cut <= right for cut in cuts)
        frames = [previous_pixels]
        for frame in range(left + 1, right + 1):
            pixels = luma(next(images)[1], 960)
            if eligible:
                frames.append(pixels)
            if cv2.absdiff(pixels, previous_pixels).mean() > 42:
                cuts.add(frame)
                eligible = False
            previous_pixels = pixels
        if eligible and len(frames) > 2:
            boxes[left + 1:right] = list(track_span(frames, keys[left], keys[right]))
    video.write(output, boxes, cuts)


def thumbnail(pixels):
    gray = luma(pixels, 96)
    # The stitched file burns a camera index into the upper-right corner.
    return gray[4:].astype(np.float32)


def camera_position(pixels, cyan):
    height, width = pixels.shape[:2]
    bar = [(784 + position * 21) * width // 960 for position in range(8)]
    samples = np.array([pixels[15 * height // 540:19 * height // 540, x - 4:x + 5].mean(axis=(0, 1)) for x in bar])
    blue, green, red = samples.T
    scores = blue + green - 2 * red if cyan else red + green - 2 * blue
    camera = int(scores.argmax())
    if scores[camera] < 90:
        raise ValueError('Stitched camera index overlay is missing')
    return camera


def align_shot(stitched, raw, ratio):
    offsets = np.array([0, len(stitched) // 2, len(stitched) - 1])
    raw_offsets = np.round(offsets * float(ratio)).astype(int)
    count = len(raw) - raw_offsets[-1]
    if count <= 0:
        raise ValueError('Stitched camera segment is longer than its raw source')
    costs = np.zeros(count)
    for offset, raw_offset in zip(offsets, raw_offsets):
        costs += np.abs(raw[raw_offset:raw_offset + count] - stitched[offset]).mean(axis=(1, 2))
    first = int(costs.argmin())

    frames = np.arange(len(stitched))
    denominator = ratio.denominator
    native_steps, remainder = np.divmod(frames * ratio.numerator, denominator)
    shifts = np.arange(-3, 5)
    candidates = first + native_steps[:, None] + shifts
    image_errors = np.full(candidates.shape, np.inf)
    for index, (frame, row) in enumerate(zip(stitched, candidates)):
        inside = (row >= 0) & (row < len(raw))
        image_errors[index, inside] = np.abs(raw[row[inside]] - frame).mean(axis=(1, 2))

    # The fps filter preserves a single sampling phase for the whole camera cut.
    # Different phases only change frame selection at the rational rounding boundaries.
    phases = np.unique(np.append(0, denominator - remainder[remainder > 0]))
    phase_steps = (remainder[:, None] + phases) // denominator
    costs = np.array([image_errors[frames[:, None], column + phase_steps].sum(axis=0) for column in range(len(shifts) - 1)])
    column, phase = np.unravel_index(costs.argmin(), costs.shape)
    if not np.isfinite(costs[column, phase]):
        raise ValueError('Could not fit a complete frame-rate-consistent path into the raw source')
    path = column + phase_steps[:, phase]
    fit_errors = image_errors[frames, path]
    matched = np.where(fit_errors <= 8, candidates[frames, path], -1)
    if np.median(fit_errors) > 6:
        raise ValueError(f'Stitched camera frames do not match their raw source (median luma error {np.median(fit_errors):.2f})')
    return matched, fit_errors


def stitch_tracks(video, raw_folder, tracking_folder, athlete, output):
    camera_thumbnails = [[] for _ in range(8)]
    timeline = []
    for index, pixels in video.frames():
        camera = camera_position(pixels, athlete == 'RYACOC')
        camera_thumbnails[camera].append(thumbnail(pixels))
        timeline.append(camera)
    if sorted(timeline) != timeline or set(timeline) != set(range(8)):
        raise ValueError(f'{video.path} does not contain the eight expected sequential camera cuts')
    boxes, cuts = [], []
    for camera, frames in enumerate(camera_thumbnails, start=1):
        if camera > 1:
            cuts.append(len(boxes))
        candidates = sorted(raw_folder.glob(f'{athlete}_*_POS{camera}.*'))
        if len(candidates) != 1:
            raise ValueError(f'Expected one {athlete} POS{camera} source in {raw_folder}')
        source = Video.open(candidates[0])
        track_path = tracking_folder / f'{source.path.name}.json'
        if not track_path.is_file():
            boxes.extend([None] * len(frames))
            continue
        source_track = json.loads(track_path.read_text())
        if source_track['source'] != source.path.name or len(source_track['tracks']) != source.frame_count:
            raise ValueError(f'{track_path} does not match {source.path}')
        raw_frames = np.array([thumbnail(pixels) for _, pixels in source.frames()])
        matching, errors = align_shot(frames, raw_frames, source.fps / video.fps)
        source_boxes = source_track['tracks']
        source_cuts = source_track['cuts']
        first_matched = int(matching[matching >= 0][0])
        for cut in source_cuts:
            if cut <= first_matched:
                continue
            destination = np.flatnonzero(matching >= cut)
            if len(destination):
                cuts.append(len(boxes) + int(destination[0]))
        boxes.extend(source_boxes[index] if index >= 0 else None for index in matching)
        print(f'POS{camera}  {first_matched=}  matched {sum(matching >= 0)}/{len(frames)}, median raw-to-stitched luma error {np.median(errors):.2f}')
    video.write(output, boxes, cuts)


def preview(video, track, path, start, end, stride):
    if not 0 <= start <= end < video.frame_count or stride < 1:
        raise ValueError('Preview needs an in-range frame interval and a positive stride')
    boxes = json.loads(track.read_text())['tracks']
    tiles = []
    for frame, pixels in video.frames(start, end + 1):
        if (frame - start) % stride:
            continue
        image = cv2.resize(pixels, (320, 180), interpolation=cv2.INTER_AREA)
        if boxes[frame] is not None:
            x, y, width, height = np.array(boxes[frame]) * (320, 180, 320, 180)
            left, top = round(x - width / 2), round(y - height / 2)
            right, bottom = round(x + width / 2), round(y + height / 2)
            cv2.rectangle(image, (left, top), (right, bottom), (255, 230, 0), 1)
        cv2.putText(image, f'#{frame}   {float(frame / video.fps):.2f}s', (8, 16), cv2.FONT_HERSHEY_SIMPLEX, .42, (255, 255, 255), 1)
        tiles.append(image)
    tiles.extend([np.zeros_like(tiles[0])] * (-len(tiles) % 4))
    sheet = np.vstack([np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)])
    if not cv2.imwrite(str(path), sheet):
        raise ValueError(f'Could not write {path}')


def build_tracks(root):
    clips = root / 'public/clips'
    raw = clips / 'raw_pos'
    keyframes = root / 'scripts/downhill-keyframes'
    output = root / 'public/data/tracks'
    for athlete, clip in [('RYACOC', 'dh-athlete-a.mp4'), ('BRYBEN', 'dh-athlete-b.mp4')]:
        for camera in range(1, 9):
            sources = sorted(raw.glob(f'{athlete}_*_POS{camera}.*'))
            if len(sources) != 1:
                raise ValueError(f'Expected one {athlete} POS{camera} source in {raw}')
            source = Video.open(sources[0])
            track_video(source, keyframes / f'{source.path.name}.keyframes.json', output / f'{source.path.name}.json')
        stitch_tracks(Video.open(clips / clip), raw, output, athlete, output / f'{clip}.json')


def main():
    parser = argparse.ArgumentParser(description='Track reviewed skier boxes on their native video frames.')
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('build', help='Regenerate all reviewed Downhill tracks and map them onto the stitched clips')
    build.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    track = commands.add_parser('track')
    track.add_argument('video', type=Path)
    track.add_argument('keyframes', type=Path)
    track.add_argument('output', type=Path)
    stitch = commands.add_parser('stitch')
    stitch.add_argument('video', type=Path)
    stitch.add_argument('raw_folder', type=Path)
    stitch.add_argument('tracking_folder', type=Path)
    stitch.add_argument('athlete', choices=['RYACOC', 'BRYBEN'])
    stitch.add_argument('output', type=Path)
    review = commands.add_parser('preview')
    review.add_argument('video', type=Path)
    review.add_argument('track', type=Path)
    review.add_argument('output', type=Path)
    review.add_argument('start', type=int)
    review.add_argument('end', type=int)
    review.add_argument('stride', type=int)
    args = parser.parse_args()
    cv2.setNumThreads(2)
    if args.command == 'build':
        build_tracks(args.root)
        return
    video = Video.open(args.video)
    if args.command == 'track':
        track_video(video, args.keyframes, args.output)
    elif args.command == 'stitch':
        stitch_tracks(video, args.raw_folder, args.tracking_folder, args.athlete, args.output)
    else:
        preview(video, args.track, args.output, args.start, args.end, args.stride)


if __name__ == '__main__':
    main()
