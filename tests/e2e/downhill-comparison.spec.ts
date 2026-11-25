import { expect, test } from '@playwright/test';

test.use({ channel: 'chrome' });

test('opens the Beaver Creek film and serves each athlete result file', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ryan Cochran-Siegle vs. Bryce Bennett' })).toBeVisible();
  const video = page.locator('main video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
    width: element.videoWidth,
    height: element.videoHeight,
    duration: element.duration,
  }))).toEqual({ width: 1920, height: 1080, duration: 54.5 });
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);

  const results = await page.locator('a[download][href$=".csv"]').evaluateAll((links) => {
    return links.map((link) => link.getAttribute('href'));
  });
  expect(results.length).toBeGreaterThanOrEqual(2);
  for (const result of results) {
    if (!result) throw new Error('Missing CSV URL');
    const response = await request.get(result);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(/^athlete,time_utc,run_elapsed_s,distance_m,speed_kmh,/);
  }
});
