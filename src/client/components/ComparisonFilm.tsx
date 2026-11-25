import { useEffect, useState } from 'react';

interface ResultFile {
  name: string;
  csv: string;
  total_elapsed_s: number;
  finish_kind: string;
}

interface SectionResult {
  start_m: number;
  end_m: number;
  gain_a_s: number;
}

interface ComparisonSummary {
  athletes: ResultFile[];
  comparisons: {
    athlete_a: string;
    athlete_b: string;
    largest_gain: SectionResult | null;
    largest_loss: SectionResult | null;
    coaching_note: string;
  }[];
  timing_note: string;
  uncertainty_note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSection(value: unknown): value is SectionResult | null {
  return value === null || (isRecord(value) && typeof value.start_m === 'number' &&
    typeof value.end_m === 'number' && typeof value.gain_a_s === 'number' && Number.isFinite(value.gain_a_s));
}

function isSummary(value: unknown): value is ComparisonSummary {
  if (!isRecord(value) || value.version !== 1 || typeof value.timing_note !== 'string' ||
    typeof value.uncertainty_note !== 'string') return false;
  if (!Array.isArray(value.athletes) || !Array.isArray(value.comparisons)) return false;
  return value.athletes.every((athlete: unknown) => isRecord(athlete) &&
    typeof athlete.name === 'string' && typeof athlete.csv === 'string' && /^[\w-]+\.csv$/.test(athlete.csv) &&
    typeof athlete.total_elapsed_s === 'number' && Number.isFinite(athlete.total_elapsed_s) &&
    typeof athlete.finish_kind === 'string') &&
    value.comparisons.length > 0 && value.comparisons.every((comparison: unknown) => isRecord(comparison) &&
      typeof comparison.athlete_a === 'string' && typeof comparison.athlete_b === 'string' &&
      typeof comparison.coaching_note === 'string' &&
      isSection(comparison.largest_gain) && isSection(comparison.largest_loss));
}

type SampleState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; summary: ComparisonSummary };

export function ComparisonFilm() {
  const [state, setState] = useState<SampleState>({ kind: 'loading' });
  const [videoError, setVideoError] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    async function loadSample() {
      try {
        const response = await fetch('/comparison/summary.json', { signal: abort.signal });
        if (!response.ok) throw new Error('Sample unavailable');
        const summary: unknown = await response.json();
        if (!isSummary(summary)) throw new Error('Invalid sample summary');
        setState({ kind: 'ready', summary });
      } catch {
        if (!abort.signal.aborted) setState({ kind: 'unavailable' });
      }
    }
    void loadSample();
    return () => abort.abort();
  }, []);

  if (state.kind === 'loading') return <p className="comparison-status" role="status">Loading comparison…</p>;
  if (state.kind === 'unavailable') {
    return <p className="comparison-status" role="status">The Beaver Creek sample is unavailable in this build.</p>;
  }

  const { summary } = state;
  const comparison = summary.comparisons[0];
  const sections = [comparison.largest_gain, comparison.largest_loss].filter((section) => section !== null);

  return (
    <main className="comparison-film">
      <header className="comparison-film-heading">
        <div>
          <p>Beaver Creek Downhill Training · December 3, 2025</p>
          <h1>{comparison.athlete_a} vs. {comparison.athlete_b}</h1>
        </div>
        <a className="comparison-download" href="/clips/downhill-comparison.mp4" download>Download MP4</a>
      </header>
      <video controls playsInline preload="metadata" poster="/comparison/poster.jpg" src="/clips/downhill-comparison.mp4"
        aria-label="Beaver Creek course-position comparison" onError={() => setVideoError(true)} />
      {videoError && <p className="comparison-status" role="status">The comparison film is unavailable in this build.</p>}

      <div className="comparison-detail-grid">
        <section className="comparison-detail">
          <h2>Coaching summary</h2>
          <p>{comparison.coaching_note}</p>
          {sections.length > 0 && <ul className="comparison-sections">
            {sections.map((section) => (
              <li key={section.start_m}>
                <span>{Math.round(section.start_m).toLocaleString('en-US')}–{Math.round(section.end_m).toLocaleString('en-US')} m</span>
                <strong>{Math.abs(section.gain_a_s).toFixed(2)}s gained by{' '}
                  {section.gain_a_s >= 0 ? comparison.athlete_a : comparison.athlete_b}</strong>
              </li>
            ))}
          </ul>}
        </section>
        <section className="comparison-detail">
          <h2>Telemetry exports</h2>
          <ul className="comparison-sections">
            {summary.athletes.map((athlete) => (
              <li key={athlete.csv}>
                <span>{athlete.name}</span>
                <a href={`/comparison/${athlete.csv}`} download>CSV</a>
              </li>
            ))}
            <li><span>Calibrated sample holdout</span><a href="/comparison/holdout.json" download>JSON</a></li>
            <li><span>New-footage browser holdout</span><a href="/comparison/browser-holdout.json" download>JSON</a></li>
          </ul>
          <p>{summary.timing_note} {summary.uncertainty_note}</p>
        </section>
      </div>
    </main>
  );
}
