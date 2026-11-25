import { test, expect } from '@playwright/test';

test.describe('Alpine Race Telemetry Coach E2E Verification', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => console.log(`PAGE LOG: [${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`PAGE ERROR: ${err.message}`));
    // Navigate to the coaching app
    await page.goto('/?view=reference');
    // Wait for the app container to be rendered
    await expect(page.locator('.app-container')).toBeVisible({ timeout: 10000 });
  });

  test('(a) CUJ 1: Switching between Super-G and Downhill updates video stage, 2D map, and micro-sector bar', async ({
    page,
  }) => {
    const raceSelector = page.getByTestId('race-selector');
    const courseMap = page.getByTestId('course-track-map-2d');
    const sectors = page.getByTestId('micro-sector-bar').locator('[data-testid^="micro-sector-btn-"]');
    const stage = page.getByTestId('video-telemetry-stage');
    const videos = stage.locator('video');
    await expect(raceSelector).toHaveValue('beaver-creek-men-dh-2025');
    await expect(courseMap).toContainText('Birds of Prey Downhill Course (2,349m)');
    await expect(sectors).toHaveCount(5);
    await expect(stage).toContainText('Bryce Bennett');
    await expect(videos).toHaveCount(2);
    await expect(videos.nth(0)).toHaveAttribute('src', '/api/clips/dh-athlete-a.mp4');
    await expect(videos.nth(1)).toHaveAttribute('src', '/api/clips/dh-athlete-b.mp4');

    await stage.getByRole('button', { name: 'Primary run' }).click();
    await expect(videos.nth(0)).toBeVisible();
    await expect(videos.nth(1)).toBeHidden();
    await stage.getByRole('button', { name: 'Side-by-Side' }).click();
    await expect(videos.nth(1)).toBeVisible();

    await raceSelector.selectOption('beaver-creek-men-sg-2025');
    await expect(courseMap).toContainText('GPS Gate Survey (38 Gates, 1,672.91m)');
    await expect(sectors).toHaveCount(6);
    await expect(page.getByTestId('synthetic-demo-banner')).toHaveText('Simulated Demo');
    await expect(stage).toContainText('Marco Odermatt');

    await raceSelector.selectOption('beaver-creek-men-dh-2025');
    await expect(stage).toContainText('Bryce Bennett');
  });

  test('(b) CUJ 1: Toggling playback speed, play/pause, stepping frames, and scrubbing updates telemetry trace and skier markers', async ({
    page,
  }) => {
    // 1. Verify speed toggling (0.5x, 1x, 2x)
    const speedBtn05 = page.locator('[data-testid="speed-btn-0.5x"]');
    const speedBtn1 = page.locator('[data-testid="speed-btn-1x"]');
    const speedBtn2 = page.locator('[data-testid="speed-btn-2x"]');

    await speedBtn05.click();
    await expect(speedBtn05).toHaveClass(/text-cyan-400/);

    await speedBtn2.click();
    await expect(speedBtn2).toHaveClass(/text-cyan-400/);

    await speedBtn1.click();
    await expect(speedBtn1).toHaveClass(/text-cyan-400/);

    // 2. Play / Pause toggle
    const playPauseBtn = page.locator('[data-testid="play-pause-btn"]');
    await expect(playPauseBtn).toContainText('Play');
    await playPauseBtn.click();
    await expect(playPauseBtn).toContainText('Pause');
    await playPauseBtn.click();
    await expect(playPauseBtn).toContainText('Play');

    // 3. Frame stepping (+1 Frame)
    const stepFwdBtn = page.locator('[data-testid="step-fwd-btn"]');
    await stepFwdBtn.click();

    // 4. Telemetry scrubbing via chart
    const scrubSurface = page.locator('[data-testid="telemetry-scrub-surface"]');
    await expect(scrubSurface).toBeVisible();
    const scrubBox = await scrubSurface.boundingBox();
    expect(scrubBox).not.toBeNull();
    if (scrubBox) {
      await scrubSurface.click({ position: { x: scrubBox.width * 0.5, y: scrubBox.height * 0.5 } });
    }

    // 5. Verify HUD and skier markers updated
    const hud = page.locator('[data-testid="f1-ghost-hud"]');
    await expect(hud).toBeVisible();

    const ghostBadge = page.locator('[data-testid="ghost-delta-badge"]');
    await expect(ghostBadge).toBeVisible();
    await expect(ghostBadge).not.toHaveText('0.00s EVEN');

    const skierA = page.locator('[data-testid="skier-marker-a"]');
    const skierB = page.locator('[data-testid="skier-marker-b"]');
    await expect(skierA).toBeVisible();
    await expect(skierB).toBeVisible();

    const liveGap = page.locator('[data-testid="live-meter-gap"]');
    await expect(liveGap).toBeVisible();
    await expect(liveGap).toContainText('m');

    // 6. Verify 8-camera ribbon (POS1..POS8) jump and active camera indicator
    await page.locator('[data-testid="cam-pos-btn-4"]').click();
    await expect(page.locator('[data-testid="active-camera-indicator"]')).toContainText(
      'CAM POS 4/8'
    );
    await page.locator('[data-testid="cam-pos-btn-8"]').click();
    await expect(page.locator('[data-testid="active-camera-indicator"]')).toContainText(
      'CAM POS 8/8'
    );
  });

  test('(c) CUJ 2: Clicking coaching summary card seeks video, aligns side-by-side Spatial-Ghost Sync, and opens Gate Split Snapshot modal', async ({
    page,
  }) => {
    const coachingPanel = page.locator('[data-testid="coaching-summary-panel"]');
    await expect(coachingPanel).toBeVisible();

    // 1. Click Jump to Section on the first coaching highlight card
    const jumpBtn = page.locator('[data-testid="jump-to-section-btn-0"]');
    await expect(jumpBtn).toBeVisible();
    await jumpBtn.click();

    // Verify side-by-side mode and Spatial Ghost sync are activated
    const sideBySideBtn = page.locator('[data-testid="mode-side-by-side-btn"]');
    await expect(sideBySideBtn).toHaveClass(/text-amber-400/);

    const spatialGhostBtn = page.locator('[data-testid="sync-spatial-ghost-btn"]');
    await expect(spatialGhostBtn).toHaveClass(/text-cyan-400/);
    await expect(page.getByTestId('real-telemetry-banner')).toBeVisible();
    await expect(page.getByTestId('active-camera-indicator')).toContainText('CAM POS');

    // Gate snapshots belong to the Super-G demo.
    await page.getByTestId('race-selector').selectOption('beaver-creek-men-sg-2025');
    await expect(page.getByTestId('synthetic-demo-banner')).toBeVisible();
    const snapshotBtn = page.locator('[data-testid="gate-snapshot-btn-0"]');
    await expect(snapshotBtn).toBeVisible();
    await snapshotBtn.click();

    const snapshotModal = page.locator('[data-testid="gate-split-snapshot-modal"]');
    await expect(snapshotModal).toBeVisible();
    await expect(snapshotModal).toContainText('Split Snapshot');
    await expect(snapshotModal).toContainText('Spatial-Ghost Sync');
    await expect(page.locator('[data-testid="snapshot-canvas-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="snapshot-canvas-b"]')).toBeVisible();

    // 3. Close the modal
    const closeBtn = page.locator('[data-testid="close-snapshot-btn"]');
    await closeBtn.click();
    await expect(snapshotModal).not.toBeVisible();
  });

  test('(d) CUJ 3: Super-G switches between course map modes', async ({ page }) => {
    await page.getByTestId('race-selector').selectOption('beaver-creek-men-sg-2025');
    const gpsToggleBtn = page.locator('[data-testid="toggle-gps-enhancement-btn"]');
    await expect(gpsToggleBtn).toBeVisible();

    const courseMap = page.locator('[data-testid="course-track-map-2d"]');
    await expect(courseMap).toContainText('GPS Gate Survey');

    await gpsToggleBtn.click();
    await expect(courseMap).toContainText('Video-Only Baseline Mode');

    // Verify toggling back restores GPS mode
    await gpsToggleBtn.click();
    await expect(courseMap).toContainText('GPS Gate Survey');
  });

  test('(e) CUJ 4: Nudging Gate 12 by +2 frames (+0.067s) in Anchor Calibration Drawer updates badge to Manually Annotated and saves the override', async ({
    page,
  }) => {
    await page.getByTestId('race-selector').selectOption('beaver-creek-men-sg-2025');
    await expect(page.getByTestId('synthetic-demo-banner')).toBeVisible();
    const openCalibrationBtn = page.locator('[data-testid="open-calibration-btn"]');
    await openCalibrationBtn.click();

    const drawer = page.locator('[data-testid="anchor-calibration-drawer"]');
    await expect(drawer).toBeVisible();

    // 2. Locate Gate 12 row
    const gate12Row = page.locator('[data-testid="anchor-row-gate-12"]');
    await expect(gate12Row).toBeVisible();
    await expect(gate12Row).toContainText('Gate 12');

    // 3. Click +2 Frames nudge (+0.067s)
    const nudge2FwdBtn = page.locator('[data-testid="nudge-2f-fwd-btn-gate-12"]');
    await nudge2FwdBtn.click();

    // 4. Verify badge updates to "Manually Annotated"
    await expect(gate12Row).toContainText('Manually Annotated');
    await expect(drawer).toContainText('Recomputed in < 2ms');

    // 5. Save to Cloudflare D1
    const saveBtn = page.locator('[data-testid="apply-anchor-override-btn"]');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(drawer).toContainText('Saved anchor overrides for this preview.');

    // 6. Reset to Factory Baseline
    const resetBtn = page.locator('[data-testid="reset-baseline-btn"]');
    await resetBtn.click();
    await expect(drawer).toContainText('Reset to factory baseline manifest complete.');

    // 7. Close drawer
    const closeDrawerBtn = page.locator('[data-testid="close-calibration-drawer-btn"]');
    await closeDrawerBtn.click();
    await expect(drawer).not.toBeVisible();
  });
});
