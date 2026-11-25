CREATE TABLE IF NOT EXISTS anchor_overrides (
  race_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  video_timestamp_sec REAL NOT NULL CHECK (video_timestamp_sec >= 0.0),
  provenance TEXT NOT NULL DEFAULT 'MANUALLY_ANNOTATED',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (race_id, athlete_id, anchor_id)
);
