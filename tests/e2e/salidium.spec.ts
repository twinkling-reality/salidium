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

  /*
   * The report is the screen the product's own vocabulary appears on, so it is the screen that has
   * to carry a route to what defines it. This used to be reachable only before a reader's first
   * run had ever happened, which is to say never again afterwards.
   */
  const docs = page.getByRole('link', { name: 'Docs' });
  await expect(docs).toBeVisible();
  await expect(docs).toHaveAttribute('href', 'https://salidium.com/docs');
  await expect(docs).toHaveAttribute('target', '_blank');

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

/*
 * Everything that arrives with motion leaves the same way, which is a rule no unit test can hold:
 * it is a claim about what the stylesheet does across two frames of a real compositor.
 *
 * The assertion is deliberately about the mechanism rather than about a duration. A surface has
 * left properly when three things are true at once: it is still painted on the frame it was
 * dismissed, a transition is actually running on it, and once that has settled it is
 * `display: none` and so holds nothing focusable.
 *
 * The failure this guards against is the one the whole pass was about, and it looks identical in
 * a screenshot to a correct exit: the element simply is not there on the next frame.
 */
test('a surface that arrives with motion also leaves with it', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  await openSalidium(page, daemon);

  const leaving = (selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const running = el
        .getAnimations()
        .filter((a) => a.constructor.name === 'CSSTransition')
        .map((a) => (a as CSSTransition).transitionProperty);
      return {
        found: true,
        display: getComputedStyle(el).display,
        running,
      };
    }, selector);

  const settled = (selector: string) =>
    page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { found: false };
      await Promise.allSettled(el.getAnimations().map((a) => a.finished));
      return {
        found: true,
        display: getComputedStyle(el).display,
        focusable: [...el.querySelectorAll('a[href], button, input')].filter(
          (node) => node.getClientRects().length > 0,
        ).length,
      };
    }, selector);

  // The panel over the page.
  await page.getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByRole('dialog', { name: 'Evidence' })).toBeVisible();
  await page.getByTitle('Close (Esc)').click();
  const panelLeaving = await leaving('.panel-scrim');
  // Asserted before the two below, which a vanished element would otherwise satisfy by absence.
  expect(panelLeaving.found, 'the scrim is still in the document while it leaves').toBe(true);
  expect(panelLeaving.display, 'the scrim is still painted while it leaves').not.toBe('none');
  expect(panelLeaving.running, 'the scrim leaves over time').toContain('opacity');
  const panelSettled = await settled('.panel-scrim');
  expect(panelSettled.display).toBe('none');
  expect(panelSettled.focusable, 'a closed panel holds nothing focusable').toBe(0);

  // The scrubber at the pane's foot, whose height the document reserves.
  await page.getByRole('button', { name: 'Rewind' }).click();
  await expect(page.locator('.rewind')).toBeVisible();
  await page.getByRole('button', { name: 'Rewind' }).click();
  const footLeaving = await leaving('.rewind');
  expect(footLeaving.found, 'the scrubber is still in the document while it leaves').toBe(true);
  expect(footLeaving.display, 'the scrubber is still painted while it leaves').not.toBe('none');
  expect(footLeaving.running, 'the scrubber leaves over time').toContain('opacity');
  const footSettled = await settled('.rewind');
  expect(footSettled.display).toBe('none');

  /*
   * The clearance the document keeps under the foot is measured from the foot's own box by
   * `useFootSpace`, so a surface that lingers to fade has to give that room back when it finally
   * goes. Left behind, it is a band of empty page below the last thing written on it.
   */
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector('.session-main') as HTMLElement;
        const foot = document.querySelector('.session-foot') as HTMLElement;
        return {
          reserved: pane.style.getPropertyValue('--foot-space'),
          actual: `${foot.getBoundingClientRect().height}px`,
        };
      }),
    )
    .toEqual({ reserved: expect.anything(), actual: expect.anything() });

  const space = await page.evaluate(() => {
    const pane = document.querySelector('.session-main') as HTMLElement;
    const foot = document.querySelector('.session-foot') as HTMLElement;
    return {
      reserved: parseFloat(pane.style.getPropertyValue('--foot-space')),
      actual: foot.getBoundingClientRect().height,
    };
  });
  expect(space.reserved, 'the document stops reserving room the scrubber no longer needs').toBe(
    space.actual,
  );
});

/*
 * The same rule on the surface where it is most visible and hardest to get right.
 *
 * The session list is one element playing two parts. Wide, it is a grid column and folding it
 * rewrites the shell's tracks in a frame, so it deliberately keeps no motion at all; narrow, it
 * is a drawer standing out of flow over the document, where it slides. Only the second is
 * asserted here, because only the second has a gesture to hold it to.
 *
 * `inert` is the half of this that CSS cannot state. A drawer spends 180ms painted after it has
 * been dismissed, and for that time it still holds thirty focusable rows; the keyboard must not
 * be able to walk back into a list the reader has just put away.
 */
test('the session list drawer slides out and is unreachable while it does', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes('narrow'), 'narrow flow');
  await openSalidium(page, daemon);

  const drawer = page.locator('aside.side');
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute('inert', '');

  await drawer.getByTitle('Hide the session list ([)').click();

  const leaving = await page.evaluate(() => {
    const el = document.querySelector('aside.side') as HTMLElement;
    return {
      display: getComputedStyle(el).display,
      running: el
        .getAnimations()
        .filter((a) => a.constructor.name === 'CSSTransition')
        .map((a) => (a as CSSTransition).transitionProperty),
      inert: el.hasAttribute('inert'),
      reachable: [...el.querySelectorAll('button, input')].filter(
        (node) => node.getClientRects().length > 0,
      ).length,
    };
  });
  expect(leaving.display, 'the drawer is still painted while it leaves').not.toBe('none');
  expect(leaving.running, 'it slides as well as fades').toEqual(
    expect.arrayContaining(['opacity', 'transform']),
  );
  expect(leaving.inert, 'and is inert for every frame of it').toBe(true);
  /*
   * The rows are still laid out, which is the whole reason the line above matters: `display: none`
   * has not arrived yet, so nothing but `inert` is keeping the keyboard out of them. If this ever
   * reads zero the drawer has stopped being painted and the assertion above proves nothing.
   */
  expect(leaving.reachable, 'its rows are still painted while it leaves').toBeGreaterThan(0);

  await expect(drawer).toBeHidden();
  await expect(page.locator('.side-backdrop')).toBeHidden();
});
