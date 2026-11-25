import { expect, test } from '@playwright/test';

test.use({ channel: 'chrome' });

test('keeps both skier readouts in place as the 3D slope animates', async ({ page }) => {
  await page.goto('/?view=reference');
  const map = page.getByTestId('slope-3d-reconstructor');
  const readouts = map.getByRole('term');
  await expect(readouts).toHaveText(['Ryan Cochran-Siegle', 'Bryce Bennett']);

  const slope = map.getByTestId('chase-3d-canvas');
  const screenshot = () => slope.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const pausedFrame = await screenshot();
  const positions = () => readouts.evaluateAll((names) => names.map((name) => ({
    left: name.getBoundingClientRect().left,
    top: name.getBoundingClientRect().top + window.scrollY,
  })));
  const pausedPositions = await positions();

  await page.getByTestId('play-pause-btn').click();
  await expect.poll(screenshot).not.toBe(pausedFrame);
  expect(await positions()).toEqual(pausedPositions);

  await map.getByTestId('3d-mode-mountain-btn').click();
  await expect(map.getByTestId('mountain-3d-canvas')).toBeVisible();
  await expect(readouts).toHaveText(['Ryan Cochran-Siegle', 'Bryce Bennett']);
});
