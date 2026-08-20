import AxeBuilder from '@axe-core/playwright';
import { expect, openSalidium, test } from './fixtures.ts';

async function expectNoA11yViolations(page: import('@playwright/test').Page): Promise<void> {
  // Measure contrast at the settled surface, not while the panel fade is blending its text with
  // the dimmed page beneath it. Replaced animations reject `finished` when canceled, so settling
  // must treat that normal lifecycle as completion instead of aborting the accessibility scan.
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})`)
      .join('\n'),
  ).toEqual([]);
}

test('session evidence, source drill-through, and live updates remain accessible', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  let streamAttempts = 0;
  await page.route('**/api/sessions/**/stream**', async (route) => {
    streamAttempts += 1;
    if (streamAttempts === 1) await route.abort('connectionreset');
    else await route.continue();
  });
  await openSalidium(page, daemon);
  await expect.poll(() => streamAttempts).toBeGreaterThanOrEqual(2);
  await expectNoA11yViolations(page);

  const evidenceTrigger = page.getByRole('button', { name: 'Evidence' });
  await evidenceTrigger.click();
  const evidence = page.getByRole('dialog', { name: 'Evidence' });
  await expect(evidence).toBeVisible();
  await expect(evidence.getByRole('button', { name: /Coverage\s+1/ })).toBeVisible();
  await expect(evidence.getByRole('button', { name: /Checks\s+1/ })).toBeVisible();
  await expect(evidence.getByRole('button', { name: /Changed\s+1/ })).toBeVisible();
  await expect(evidence.getByRole('button', { name: /What happened\s+1/ })).toBeVisible();
  await expectNoA11yViolations(page);

  await evidence.getByRole('button', { name: /Changed\s+1/ }).click();
  await expect(evidence.getByRole('button', { name: /^cart\.ts/ })).toBeVisible();

  daemon.appendEdit('/repo/checkout/src/shipping.ts');
  await expect(evidence.getByRole('button', { name: /Changed\s+2/ })).toBeVisible();
  await expect(evidence.getByRole('button', { name: /^shipping\.ts/ })).toBeVisible();

  const recordTrigger = evidence.getByRole('button', { name: /^shipping\.ts/ });
  await recordTrigger.click();
  const source = page.locator('.drawer[role="dialog"]');
  await expect(source).toBeVisible();
  await expect(source.getByRole('button', { name: 'Provider record' })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.keyboard.press('Escape');
  await expect(source).toBeHidden();
  await expect(recordTrigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(evidence).toBeHidden();
  await expect(evidenceTrigger).toBeFocused();
});

test('sessions without evidence omit the control and panel', async ({ page, daemon }, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  await openSalidium(page, daemon);

  const find = page.getByRole('textbox', { name: 'Find a session by name, repo or id' });
  await find.fill('empty-session');
  await page.getByRole('button', { name: /Empty transcript/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Empty transcript' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Evidence' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Evidence' })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('narrow session navigation is a contained modal across resize', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes('narrow'), 'narrow flow');
  await openSalidium(page, daemon);

  const sessions = page.getByRole('dialog', { name: 'Salidium' });
  const close = page.locator('aside.side').getByTitle('Hide the session list ([)');
  await expect(sessions).toBeVisible();
  await expect(close).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect(page.locator('.side-backdrop')).toHaveJSProperty('tagName', 'DIV');
  await expect(page.locator('.side-backdrop')).not.toHaveAttribute('tabindex', /.+/);

  const focusables = sessions.locator(
    'a[href]:visible, button:not([disabled]):visible, input:not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible, [tabindex]:not([tabindex="-1"]):visible',
  );
  const first = focusables.first();
  const last = focusables.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.evaluate(() => {
    const outside = document.createElement('button');
    outside.id = 'outside-focus-probe';
    document.querySelector('main')?.append(outside);
    outside.focus();
  });
  await expect
    .poll(() => sessions.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await expectNoA11yViolations(page);

  await page.keyboard.press('Escape');
  await expect(sessions).toBeHidden();
  const reopen = page.locator('.mobile-side-trigger').getByTitle('Show the session list ([)');
  await expect(reopen).toBeFocused();

  await reopen.click();
  await expect(close).toBeFocused();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Salidium' })).toHaveCount(0);
  await expect(page.locator('aside.side')).toBeVisible();
  await expect(close).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog', { name: 'Salidium' })).toBeVisible();
  await expect(close).toBeFocused();
});
