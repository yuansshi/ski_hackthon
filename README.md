# Alpine Race Telemetry

Compare two downhill runs using the coaches’ videos. The Beaver Creek sample pairs Ryan Cochran-Siegle and Bryce Bennett at eight recognizable points on the December 3, 2025 training course. The film shows each racer’s elapsed time, estimated speed, and the time gap at the same course position.

[Alpine Telemetry Starter Pack](https://docs.google.com/document/d/1aQ59SEEmeJoALEXRqON8ZetprDRSQlCGIyRiOQxfyNg/export?format=txt)

## Open the sample

Install Node.js 20 or later and run:

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. The **Beaver Creek comparison** page includes the film, a coaching summary, and per-athlete CSV exports. The **GNSS reference** page shows the separate legacy viewer with approximate video alignment. Its Super-G entry is a simulated replay.

## Analyze a new race

1. Open **Analyze footage** in a current Chrome or Edge browser. Load the original MP4 or MOV clips containing left-channel 25 fps SMPTE timecode.
2. Enter the course length, start altitude, and finish altitude. Enter the two racer names and confirm each clip’s camera position.
3. Mark the start for each racer. Add matching landmarks by placing each video at the frame where the skier passes the same gate or stripe. Mark the finish if both clips show it. Leave unknown landmark distances blank to use the course-scale estimate.
4. Trim clip portions before the skier appears or after the skier leaves the scheduled view. The editor retains decoded timestamps inside the trimmed intervals.
5. Select **Analyze comparison**. Scrub by distance to inspect both runs, the estimated speeds, and the running gap. Export each skier’s CSV from the results.

The browser reads the input clips locally. The CSV contains `athlete`, `time_utc`, `run_elapsed_s`, `distance_m`, and `speed_kmh` at 10 Hz where source video and timecode support the sample. Additional fields identify the source and estimate uncertainty.

## Rebuild the Beaver Creek sample

Install FFmpeg, Python 3.10 or later, and [uv](https://docs.astral.sh/uv/). Put the organizer’s December 3 POS clips in `public/clips/raw_pos/` with their original names. The local pack includes the cue annotations, reviewed track boxes, and frozen course calibration.

```sh
python3 scripts/decode-downhill-ltc.py public/clips/raw_pos --output artifacts/downhill-ltc.json
python3 scripts/estimate-downhill-telemetry.py analyze \
  artifacts/downhill-annotations.json artifacts/downhill-ltc.json \
  --prior artifacts/downhill-prior.json --output artifacts/downhill-telemetry
npm run build:data
uv run scripts/track-downhill.py build
uv run scripts/render-downhill-comparison.py
ffmpeg -ss 40.9667 -i public/clips/downhill-comparison.mp4 -frames:v 1 \
  -vf scale=1440:-2 -q:v 3 public/comparison/poster.jpg
```

Use the separate `validate` subcommand with the designated holdout CSVs and `publish-sample` to regenerate the exports in `public/comparison/`. The validator rejects athletes listed in the training prior. [Holdout report](public/comparison/holdout.json)

## Accuracy on held-out athletes

Bryce Bennett, Aleksander Aamodt Kilde, and Erik Arvidsson were held out of the Beaver Creek calibration. Across the three runs, the calibrated sample’s elapsed-aligned mean absolute error ranges from 2.48 to 6.76 m for distance and 3.21 to 3.70 km/h for speed. [Calibrated sample report](public/comparison/holdout.json)

The browser tool uses course facts and video marks to estimate speed and distance on a new course. On the same three runs, with intermediate distances left blank, its elapsed-aligned mean absolute error ranges from 69.79 to 81.73 m and 11.08 to 11.85 km/h. The browser report uses video through the last shared landmark. [Browser report](public/comparison/browser-holdout.json)

Run `npx tsx scripts/evaluate-browser-estimator.ts` to reproduce the browser report from the provided annotations, decoded timecode, and held-out GPS CSVs.

## How the estimates are made

- The decoder reads the left audio channel and fits continuous sections of 25 fps SMPTE timecode to the clip timeline. Visible start cues set each run’s elapsed clock.
- The Beaver Creek calibration uses training-athlete GNSS to establish distances for visible landmarks. The frozen calibration, matching landmarks, and video timecode are the inputs to each inference run. Holdout GNSS enters only the separate validation step.
- The comparison film uses matched course position, then selects the corresponding native frame from each original camera view. The skier labels follow reviewed per-frame image tracks and disappear when the skier’s track is unavailable.
- On a new course, the browser estimates distances from marked landmarks, the supplied course dimensions, and each run’s timing. Speed between points is a segment estimate. Additional matched landmarks improve the alignment.
- Some clips overlap. The estimator chooses one available view for each sample and leaves unsupported intervals out of the CSV.

## Known limitations

- The Beaver Creek cameras do not show a verified finish beam for the sample pair. The estimated finish is inferred from the last shared landmark.
- Decoded camera UTC and the wearable exports disagree at the start. The report provides both raw UTC-aligned error and error after aligning each file to its own start. The latter measures same-course agreement.
- Landmark crossings can be ambiguous under snowfall, pans, zoom, or occlusion. The speed bands report heuristic uncertainty. The footage supports coaching review of line choice, and any causal interpretation requires a coach’s judgment.
- The browser’s imported-footage workflow relies on shared landmarks the user can identify. The reviewed athlete labels in the Beaver Creek film are specific to the supplied footage.

## Verify and deploy

Use an installed Google Chrome for the film playback test.

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build:app
npx wrangler pages dev dist
```

`build:app` stages the checked-in web app, sample exports, and prepared MP4s. It excludes the organizer’s archives and raw clips and checks the Cloudflare Pages per-file limit. Use `npm run build` when you also need to regenerate the local reference clips and manifests.

After authenticating Wrangler for the intended account and selecting a Pages project, run:

```sh
npx wrangler pages deploy dist --project-name YOUR_PAGES_PROJECT
```

The Pages preview serves the prepared clips from static assets. Existing deployments can bind `R2_CLIPS` for reference clips and `DB_TELEMETRY` for persistent reference calibration. Without D1, the preview uses in-memory overrides.

## References

- [Cloudflare x U.S. Ski & Snowboard Challenge](https://docs.google.com/document/d/1GC6VGVFz1j5pg0Bm2x6p2bRYOKF6KtOZyfI5DGBeh0k/export?format=txt)
- [Fixed-camera and split-screen comparisons in alpine training](https://protern.io/blogs/news/three-different-ways-to-record-alpine-skiing-for-in-depth-video-analysis)
- [Earlier telemetry viewer design](docs/designs/alpine-race-telemetry.md)
