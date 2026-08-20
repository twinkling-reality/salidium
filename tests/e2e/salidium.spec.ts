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

interface RecordedExit {
  found: boolean;
  display: string;
  visibility: string;
  opacity: string;
  running: string[];
  /** Descendants still drawn on the frame the exit began, and so still there to be kept out of. */
  painted: number;
  inert: boolean;
}

/*
 * Recording the exit rather than sampling for it.
 *
 * The probe here used to read `getComputedStyle` one round trip after the click that dismissed the
 * surface, which is a race against the 180ms it is measuring. Under the load of three engines
 * running in parallel the round trip lost: Chromium failed two runs in three against a stylesheet
 * that was working, because the fade had already finished by the time the question was asked. The
 * listener is installed before the dismissal instead and samples inside the page on the frame the
 * transition is created, so the measurement cannot arrive late whatever the machine is doing.
 */
async function watchExit(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nothing matches ${sel}`);
    const recorded: RecordedExit = {
      found: true,
      display: '',
      visibility: '',
      opacity: '',
      running: [],
      painted: 0,
      inert: false,
    };
    const scope = window as unknown as { __exit: RecordedExit; __exitDone: Promise<void> };
    scope.__exit = recorded;
    /*
     * Transition events are queued rather than dispatched inside the style recalculation, so a
     * question asked the instant after the click can still beat the answer to it. This resolves
     * once the exit has both started and settled, and the sample above was taken when it started,
     * so reading late costs nothing and reading early is no longer possible. The deadline is what
     * turns "no transition was ever created" into a failed assertion rather than a hung test.
     */
    scope.__exitDone = new Promise<void>((resolve) => {
      const deadline = performance.now() + 2_000;
      const tick = () => {
        const running = el.getAnimations().some((animation) => animation.playState === 'running');
        if ((recorded.running.length > 0 && !running) || performance.now() > deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    el.addEventListener('transitionrun', (event) => {
      if (event.target !== el) return;
      if (recorded.running.length === 0) {
        const style = getComputedStyle(el);
        recorded.display = style.display;
        recorded.visibility = style.visibility;
        recorded.opacity = style.opacity;
        recorded.inert = el.hasAttribute('inert');
        recorded.painted = [...el.querySelectorAll('a[href], button, input')].filter(
          (node) =>
            node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible',
        ).length;
      }
      recorded.running.push((event as TransitionEvent).propertyName);
    });
  }, selector);
}

async function recordedExit(page: import('@playwright/test').Page): Promise<RecordedExit> {
  return page.evaluate(async () => {
    const scope = window as unknown as { __exit?: RecordedExit; __exitDone?: Promise<void> };
    await scope.__exitDone;
    return (
      scope.__exit ?? {
        found: false,
        display: '',
        visibility: '',
        opacity: '',
        running: [],
        painted: 0,
        inert: false,
      }
    );
  });
}

/*
 * What the closed surface is worth to the keyboard, asked rather than inferred.
 *
 * A count of client rects answered this while the closed state was `display: none`, because a
 * closed surface had no boxes at all. `visibility: hidden` leaves every rect exactly where layout
 * put it, and the property under test was never whether a row has a box: it is whether the
 * keyboard can land on one. So each candidate is offered focus and asked whether it took it.
 */
function settled(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ found: boolean; visibility: string; candidates: number; focusable: number }> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, visibility: '', candidates: 0, focusable: 0 };
    await Promise.allSettled(el.getAnimations().map((animation) => animation.finished));
    const restore = document.activeElement as HTMLElement | null;
    const candidates = [...el.querySelectorAll<HTMLElement>('a[href], button, input')];
    let focusable = 0;
    for (const node of candidates) {
      node.focus();
      if (document.activeElement === node) focusable += 1;
    }
    restore?.focus?.();
    return {
      found: true,
      visibility: getComputedStyle(el).visibility,
      candidates: candidates.length,
      focusable,
    };
  }, selector);
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

/*
 * The section that quotes a delegated agent verbatim, which nothing could reach until a fixture
 * had one. It guards three things at once: that the disclosure counts the lanes and how many of
 * them reported, that a lane which ended silently says so rather than being dropped, and that the
 * "more" control appears over a statement with something behind it and not over one without.
 *
 * The last of those is why the two lanes are deliberately unalike. A control over text with
 * nothing behind it is worse than no control, and only a measurement can tell the two apart.
 */
test('a session that delegated says what came back', async ({ page, daemon }, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  await openSalidium(page, daemon);

  const find = page.getByRole('textbox', { name: 'Find a session by name, repo or id' });
  await find.fill('e2e-fanout');
  await page.getByRole('button', { name: /Find the unbounded queries/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Find the unbounded queries' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Evidence' }).click();
  await page.getByRole('button', { name: /What happened/ }).click();

  const delegated = page.getByRole('button', { name: 'Delegated to 2 agents, 1 reported back' });
  await expect(delegated).toBeVisible();
  await delegated.click();

  const rows = page.locator('.rows .row.is-quote');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Read the reporting endpoints' })).toContainText(
    'ended without reporting',
  );

  const reported = rows.filter({ hasText: 'Read the orders endpoints' });
  const clamped = await reported
    .locator('.rp-statement-body')
    .evaluate((el) => el.scrollHeight - el.clientHeight > 1);
  expect(clamped, 'the fixture statement is long enough to be cut off at this width').toBe(true);
  const more = reported.getByRole('button', { name: 'more' });
  await expect(more, 'so the control that opens it is offered').toBeVisible();

  await more.click();
  await expect(reported.getByRole('button', { name: 'less' })).toBeVisible();
  const opened = await reported
    .locator('.rp-statement-body')
    .evaluate((el) => el.scrollHeight - el.clientHeight > 1);
  expect(opened, 'and opening it shows the whole statement').toBe(false);

  /* The lane that wrote one line is not clamped, so it is offered no control at all. */
  await expect(
    rows.filter({ hasText: 'Read the reporting endpoints' }).getByRole('button', { name: 'more' }),
  ).toHaveCount(0);

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
 * `visibility: hidden` and so holds nothing the keyboard can reach.
 *
 * The failure this guards against is the one the whole pass was about, and it looks identical in
 * a screenshot to a correct exit: the element simply is not there on the next frame. It caught
 * exactly that in Firefox, where the `display`-carried version of the idiom ran nothing at all;
 * the reason, and what replaced it, are recorded at `.arrives` in `scale.css`.
 */
test('a surface that arrives with motion also leaves with it', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  await openSalidium(page, daemon);

  // The panel over the page.
  await page.getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByRole('dialog', { name: 'Evidence' })).toBeVisible();
  await watchExit(page, '.panel-scrim');
  await page.getByTitle('Close (Esc)').click();
  const panelLeaving = await recordedExit(page);
  // Asserted before the two below, which a vanished element would otherwise satisfy by absence.
  expect(panelLeaving.found, 'the scrim is still in the document while it leaves').toBe(true);
  expect(panelLeaving.running, 'the scrim leaves over time').toContain('opacity');
  expect(panelLeaving.visibility, 'the scrim is still painted while it leaves').toBe('visible');
  expect(panelLeaving.display, 'and still holds a box while it leaves').not.toBe('none');
  const panelSettled = await settled(page, '.panel-scrim');
  expect(panelSettled.visibility).toBe('hidden');
  expect(panelSettled.candidates, 'and there was something in it to reach').toBeGreaterThan(0);
  expect(panelSettled.focusable, 'a closed panel holds nothing focusable').toBe(0);

  // The scrubber at the pane's foot, whose height the document reserves.
  await page.getByRole('button', { name: 'Rewind' }).click();
  await expect(page.locator('.rewind')).toBeVisible();
  await watchExit(page, '.rewind');
  await page.getByRole('button', { name: 'Rewind' }).click();
  const footLeaving = await recordedExit(page);
  expect(footLeaving.found, 'the scrubber is still in the document while it leaves').toBe(true);
  expect(footLeaving.running, 'the scrubber leaves over time').toContain('opacity');
  expect(footLeaving.visibility, 'the scrubber is still painted while it leaves').toBe('visible');
  expect(footLeaving.display, 'and still holds a box while it leaves').not.toBe('none');
  const footSettled = await settled(page, '.rewind');
  expect(footSettled.visibility).toBe('hidden');

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

  await watchExit(page, 'aside.side');
  await drawer.getByTitle('Hide the session list ([)').click();

  const leaving = await recordedExit(page);
  expect(leaving.visibility, 'the drawer is still painted while it leaves').toBe('visible');
  expect(leaving.running, 'it slides as well as fades').toEqual(
    expect.arrayContaining(['opacity', 'transform']),
  );
  expect(leaving.inert, 'and is inert for every frame of it').toBe(true);
  /*
   * Its rows are still drawn, which is the whole reason the line above matters: the drawer is
   * still `visibility: visible` and still holds thirty focusable rows, so nothing but `inert` is
   * keeping the keyboard out of them. If this ever reads zero the drawer has stopped being
   * painted on the frame it was dismissed and the assertion above proves nothing.
   */
  expect(leaving.painted, 'its rows are still painted while it leaves').toBeGreaterThan(0);

  await expect(drawer).toBeHidden();
  await expect(page.locator('.side-backdrop')).toBeHidden();
});
