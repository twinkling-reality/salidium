import AxeBuilder from '@axe-core/playwright';
import type { OperationsOverview } from '@salidium/protocol';
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

test('generated diagrams, personalization, and report export keep their boundaries', async ({
  page,
  daemon,
}) => {
  await openSalidium(page, daemon);
  const narrow = page.viewportSize()?.width === 390;
  if (narrow) {
    await page.getByRole('button', { name: 'Hide the session list' }).click();
  }

  const explanation = page.getByRole('region', { name: 'Generated explanation' });
  await expect(explanation).toBeVisible();
  await expect(explanation.getByRole('heading', { name: 'Why' })).toBeVisible();
  await expect(explanation.getByRole('heading', { name: 'How' })).toBeVisible();
  await expect(explanation.getByRole('heading', { name: 'Approach changed' })).toBeVisible();
  await expect(explanation.locator('#sec-why ol, #sec-why ul')).toHaveCount(3);
  await expect(explanation.locator('#sec-how ul')).toHaveCount(1);

  const colors = await explanation.evaluate((region) => {
    const why = region.querySelector<HTMLElement>('#sec-why .fd-lane');
    const how = region.querySelector<HTMLElement>('#sec-how .fd-branches .fd-node');
    const background = getComputedStyle(region).backgroundColor;
    const channels = (value: string) => {
      const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return value.startsWith('color(srgb')
        ? numbers.slice(0, 3).map((number) => number * 255)
        : numbers.slice(0, 3);
    };
    const luminance = (value: string) => {
      const [r = 0, g = 0, b = 0] = channels(value).map((number) => {
        const channel = number / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const whyBorder = why ? getComputedStyle(why).borderColor : '';
    const howBorder = how ? getComputedStyle(how).borderColor : '';
    return {
      why: whyBorder,
      how: howBorder,
      whyContrast: contrast(whyBorder, background),
      howContrast: contrast(howBorder, background),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(colors.why).not.toBe('');
  expect(colors.how).not.toBe('');
  expect(colors.why).not.toBe(colors.how);
  expect(colors.whyContrast).toBeGreaterThanOrEqual(3);
  expect(colors.howContrast).toBeGreaterThanOrEqual(3);
  expect(colors.overflow).toBe(0);
  await expectNoA11yViolations(page);

  const theme = page.getByRole('button', { name: /Theme:/ });
  await theme.click();
  await theme.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoA11yViolations(page);

  const personalize = page.getByRole('region', { name: 'Generated explanation' });
  const personalizeControl = page
    .locator('.toolbar')
    .getByRole('button', { name: 'Personalize', exact: true });
  await expect(personalizeControl.locator('svg')).toHaveCount(1);
  await personalizeControl.click();
  await personalize
    .getByLabel('Terms and examples')
    .fill('I run payment operations. Use restaurant kitchens and logistics as examples.');
  await expect(personalize).toContainText('Unsaved changes');
  await personalize.getByRole('button', { name: 'Save terms', exact: true }).click();
  await expect(personalize).toContainText('Saved on this machine');
  await expect(personalize.getByRole('button', { name: 'Personalize', exact: true })).toHaveCount(
    0,
  );
  await expectNoA11yViolations(page);
  const deleteTerms = personalize.getByRole('button', {
    name: 'Delete saved terms',
    exact: true,
  });
  await expect(deleteTerms.locator('svg')).toHaveCount(1);
  await expect
    .poll(() => deleteTerms.evaluate((button) => getComputedStyle(button).borderTopWidth))
    .toBe('1px');
  await deleteTerms.click();
  await expect(personalize).toContainText('Not saved');
  await personalizeControl.click();
  await expect(personalize.getByLabel('Terms and examples')).toBeHidden();

  if (!narrow) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('salidium-improve-checkout-safeguards.json');
  }
});

test('an explicit personalization call stays reversible and presentation-only', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'the responsive dialog is covered above');
  let profile = {
    version: 2 as const,
    enabled: false,
    revision: 'none',
    profile: { guidance: '' },
  };
  let failGeneration = false;
  await page.route('**/api/settings/personalization', async (route) => {
    if (route.request().method() === 'PUT') {
      const request = route.request().postDataJSON() as Pick<typeof profile, 'enabled' | 'profile'>;
      profile = { version: 2, revision: 'e2e-profile', ...request };
    } else if (route.request().method() === 'DELETE') {
      profile = {
        version: 2,
        enabled: false,
        revision: 'none',
        profile: { guidance: '' },
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(profile),
    });
  });
  await page.route('**/api/settings/explainer', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cadence: 'session',
        backend: 'auto',
        model: null,
        envOff: false,
        backendLocked: false,
        modelLocked: false,
        activeBackend: 'auto',
        activeModel: null,
        availableBackends: ['claude', 'codex'],
        routes: {
          claudeCode: { backend: 'claude', model: 'test-explainer' },
          codex: { backend: 'codex', model: 'Codex CLI default (not pinned)' },
        },
      }),
    });
  });
  await page.route('**/api/sessions/**/personalized-presentation', async (route) => {
    if (failGeneration) {
      await route.fulfill({ status: 500, body: 'generation failed' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        basedOnSeq: 6,
        model: 'test-personalizer',
        generatedAt: '2026-08-23T18:00:00.000Z',
        profileRevision: 'e2e-profile',
        what: {
          summary: 'Checkout validation now blocks an invalid cart before payment.',
          currently: null,
        },
        why: {
          summary: 'Two tickets reach one payment gate.',
          lanes: [
            { title: 'Cart ticket', steps: ['Read every cart line', 'Reject a bad quantity'] },
            {
              title: 'Checkout ticket',
              steps: ['Read the submitted total', 'Reject a stale total'],
            },
          ],
          chain: ['Both tickets must pass', 'Payment can start'],
        },
        how: {
          summary: 'One worker checks both tickets.',
          root: 'checkout guard',
          steps: ['Check every cart line', 'Compare the submitted total', 'Return one safe result'],
        },
        approachChange: {
          from: 'Validate after payment starts',
          fromSteps: ['Create the payment request', 'Reject the invalid cart'],
          why: 'The rejected cart could already have started a payment.',
          to: 'Validate before payment starts',
          toSteps: ['Check the cart first', 'Start one valid payment'],
        },
        analogies: {
          why: 'Like two order tickets reaching one kitchen pass.',
          how: 'Like one expediter checking both tickets.',
        },
      }),
    });
  });

  await openSalidium(page, daemon);
  const panel = page.getByRole('region', { name: 'Generated explanation' });
  await page.locator('.toolbar').getByRole('button', { name: 'Personalize', exact: true }).click();
  await panel
    .getByLabel('Terms and examples')
    .fill('I run a restaurant kitchen. Use kitchen tickets and handoffs as examples.');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();

  const explanation = page.getByRole('region', { name: 'Generated explanation' });
  const personalizedControl = page
    .locator('.toolbar')
    .getByRole('button', { name: 'Personalized', exact: true });
  await expect(personalizedControl).toBeVisible();
  await expect(personalizedControl.locator('svg')).toHaveCount(1);
  await personalizedControl.click();
  await expect(panel.getByRole('button', { name: 'Applied', exact: true })).toBeDisabled();
  await expect(panel).toContainText('Saved on this machine');
  await personalizedControl.click();
  await expect(explanation.locator('.ex-version-row')).toContainText('I run a restaurant kitchen');
  await expect(explanation).toContainText('Two tickets reach one payment gate.');
  await expect(explanation).toContainText('In your terms');
  await expect(explanation).toContainText('Personalized by test-personalizer');
  const originalVersion = explanation.getByRole('button', { name: 'Original', exact: true });
  const personalizedVersion = explanation.getByRole('button', {
    name: 'Personalized',
    exact: true,
  });
  await expect(originalVersion.locator('svg')).toHaveCount(1);
  await expect(personalizedVersion.locator('svg')).toHaveCount(1);
  await expect
    .poll(() => originalVersion.evaluate((button) => getComputedStyle(button).borderTopWidth))
    .toBe('1px');
  await expect
    .poll(() => personalizedVersion.evaluate((button) => getComputedStyle(button).borderTopWidth))
    .toBe('1px');
  await originalVersion.click();
  await expect(personalizedControl).toBeVisible();
  await expect(originalVersion).toHaveAttribute('aria-pressed', 'true');
  await expect(explanation).toContainText(
    'Two checks converge before the payment request can start.',
  );
  await expect(explanation).not.toContainText('In your terms');
  await personalizedVersion.click();
  await expect(personalizedVersion).toHaveAttribute('aria-pressed', 'true');
  await expect(explanation).toContainText('Two tickets reach one payment gate.');
  await expectNoA11yViolations(page);

  failGeneration = true;
  await personalizedControl.click();
  await panel.getByLabel('Terms and examples').fill('Use logistics handoffs instead.');
  await expect(panel).toContainText('Unsaved changes');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel).toContainText('Saved, but this report was not updated. Try again.');
  await expect(panel).toContainText('Saved on this machine');
  await expect(
    page.locator('.toolbar').getByRole('button', { name: 'Personalize', exact: true }),
  ).toBeVisible();
  await expect(panel.locator('.ex-version-row')).toHaveCount(0);

  await page.reload();
  const restoredControl = page
    .locator('.toolbar')
    .getByRole('button', { name: 'Personalize', exact: true });
  await expect(restoredControl).toBeVisible();
  await restoredControl.click();
  await expect(page.getByLabel('Terms and examples')).toHaveValue(
    'Use logistics handoffs instead.',
  );
  await expect(page.getByRole('region', { name: 'Generated explanation' })).toContainText(
    'Saved on this machine',
  );
});

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

test('models and usage keeps both ledgers and explanation controls in one rail', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'desktop flow');
  await openSalidium(page, daemon);

  const modelsButton = page.getByRole('button', { name: 'Models & Usage', exact: true });
  await expect(modelsButton).not.toContainText('Local only');
  await modelsButton.click();
  const models = page.getByRole('complementary', { name: 'Models & Usage' });
  await expect(models.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(models).toContainText('test-model');
  await expect(models).toContainText('No token data');
  await expect(models.getByRole('heading', { name: 'Explanation' })).toBeVisible();
  await expect(models.getByRole('button', { name: 'Local only' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(models).toContainText('No model calls');
  await expect(models.getByRole('button', { name: 'Same as coding' })).toHaveCount(0);
  await expect(models.getByRole('button', { name: 'Choose a model' })).toHaveCount(0);

  await models.getByRole('button', { name: 'When done' }).click();
  await expect(modelsButton).not.toContainText('When done');
  await expect(models).toContainText('claude-haiku-4-5-20251001');
  await expect(models.getByRole('button', { name: 'Same as coding' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(models.getByRole('button', { name: 'When done' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(models.getByRole('textbox', { name: 'Model name' })).toHaveCount(0);
  await models.getByRole('button', { name: 'Choose a model' }).click();
  const modelChoices = models.getByRole('list', { name: 'Explanation model choices' });
  await expect(modelChoices).toBeVisible();
  await expect(
    modelChoices.getByRole('button', { name: /test-model Current coding model/ }),
  ).toBeVisible();
  await expect(
    modelChoices.getByRole('button', {
      name: /claude-haiku-4-5-20251001 Salidium default/,
    }),
  ).toHaveAttribute('aria-current', 'true');
  await modelChoices.getByRole('button', { name: /test-model Current coding model/ }).click();
  await expect(
    modelChoices.getByRole('button', { name: /test-model Current coding model/ }),
  ).toHaveAttribute('aria-current', 'true');
  await models.getByRole('button', { name: 'Codex' }).click();
  await expect(
    modelChoices.getByRole('button', { name: /Automatic Codex chooses/ }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(models.getByRole('textbox', { name: 'Model name' })).toHaveCount(0);
  await modelChoices.getByRole('button', { name: /Other model/ }).click();
  await expect(models.getByRole('textbox', { name: 'Model name' })).toBeVisible();
  await expect(models.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(models).toContainText('all runs');
  await expect(page.getByRole('dialog', { name: 'Explanation' })).toHaveCount(0);
  await models.getByRole('button', { name: 'Local only' }).click();
  await expect(models.getByRole('button', { name: 'Local only' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectNoA11yViolations(page);
});

test('the narrow layout uses the same models and usage rail', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(!testInfo.project.name.includes('narrow'), 'narrow flow');
  await openSalidium(page, daemon);

  const sessions = page.getByRole('dialog', { name: 'Salidium' });
  await expect(sessions).toBeVisible();
  await expect(sessions.getByRole('button', { name: 'Explanation model and usage' })).toHaveCount(
    0,
  );
  await sessions.getByRole('button', { name: 'Hide the session list' }).click();
  await page.getByRole('button', { name: 'Models & Usage', exact: true }).click();

  await expect(sessions).toBeHidden();
  const models = page.getByRole('complementary', { name: 'Models & Usage' });
  await expect(models).toBeVisible();
  await expect(models.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(models.getByRole('heading', { name: 'Explanation' })).toBeVisible();
  await expect(models.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Explanation' })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('ingest and storage reports local cost and controls collection', async ({ page, daemon }) => {
  await openSalidium(page, daemon);
  const narrow = page.viewportSize()?.width === 390;
  if (narrow) {
    await page.getByRole('button', { name: 'Hide the session list' }).click();
  }

  const ingestTrigger = page.getByRole('button', { name: 'Ingest & Storage', exact: true });
  await ingestTrigger.click();
  const ingest = page.getByRole('complementary', { name: 'Ingest & Storage' });
  await expect(ingest).toBeVisible();
  await expect(ingestTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(ingest).toHaveAttribute('id', 'ingest-storage-inspector');
  await expect(ingest.getByTitle('Hide Ingest & Storage')).toBeFocused();
  await expect(ingest.getByRole('heading', { name: 'Current readout' })).toBeVisible();
  await expect(ingest).toContainText('Queue velocity');
  await expect(ingest).toContainText('Drain rate');
  await expect(ingest.getByRole('heading', { name: 'Local alerts' })).toBeVisible();
  await expect(ingest.getByRole('button', { name: 'Local policy' })).toBeVisible();
  await expect(ingest.getByText('Active', { exact: true })).toBeVisible();
  await expect(ingest).toContainText('Waiting to be stored');
  await expect(ingest).toContainText('On this Mac');
  await expect(ingest).toContainText('Kept forever');
  /*
   * Where the store stands against the size that raises an alert.
   *
   * Retention defaults to keeping everything and the only signal that the store had grown was that
   * alert firing at 5 GiB, which arrives once there are already 5 GiB. A fixture store is small
   * enough that the room left rounds to the whole mark, which is the case that used to render as
   * "5.00 GiB below the 5.00 GiB warning mark".
   */
  await expect(ingest).toContainText('warns at 5.00 GiB');
  await expect(ingest.getByRole('heading', { name: 'Where it runs' })).toBeVisible();
  await expect(ingest).toContainText('Closing it does not stop collection');
  await expect(ingest).toContainText('127.0.0.1:');
  await expect(ingest.getByRole('heading', { name: 'Collection ledger' })).toBeVisible();
  await expect(ingest).toContainText('No collection gaps observed');

  await ingest.getByRole('button', { name: 'Local policy' }).click();
  const queueAgePolicy = ingest
    .locator('.operations-settings > label')
    .filter({ hasText: 'Warn when queue age reaches' });
  await queueAgePolicy.locator('select').selectOption('30');
  await expect(queueAgePolicy.locator('.setting-source')).toHaveText('stored');
  const nativeNotifications = ingest.getByRole('checkbox', {
    name: /Native desktop notifications/,
  });
  await nativeNotifications.click();
  await expect(nativeNotifications).toBeChecked();
  await ingest.getByRole('button', { name: 'Restore shipped defaults' }).click();
  await expect(ingest.getByRole('button', { name: 'Local policy' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await ingest.getByRole('button', { name: 'Local policy' }).click();
  await expect(queueAgePolicy.locator('.setting-source')).toHaveText('default');
  await expect(nativeNotifications).not.toBeChecked();

  await ingest.getByRole('button', { name: 'Pause collection' }).click();
  await expect(ingest.getByRole('button', { name: 'Resume collection' })).toBeVisible();
  await expect(ingest.getByText(/^Paused/)).toBeVisible();
  await ingest.getByRole('button', { name: 'Resume collection' }).click();
  await expect(ingest.getByRole('button', { name: 'Pause collection' })).toBeVisible();
  await expect(ingest).toContainText('Paused interval');
  await expect(ingest).toContainText('Hook-only evidence may be absent · count unavailable');

  const layout = await ingest.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      right: Math.round(innerWidth - rect.right),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(layout.width).toBeLessThanOrEqual(narrow ? 390 : 320);
  expect(layout.right).toBe(0);
  expect(layout.overflow).toBe(0);
  await expectNoA11yViolations(page);

  await ingest.getByTitle('Hide Ingest & Storage').click();
  await expect(ingest).toBeHidden();
  await expect(ingestTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(ingestTrigger).toBeFocused();
});

test('rare operations failures remain legible and actionable', async ({
  page,
  daemon,
}, testInfo) => {
  await page.route('**/api/operations', async (route) => {
    const response = await route.fetch();
    const overview = (await response.json()) as OperationsOverview;
    const at = overview.health.observedAt;
    const alert = {
      id: 'visual-maintenance-failure',
      deduplicationKey: 'maintenance-failure:visual-audit',
      kind: 'maintenance-failure' as const,
      severity: 'critical' as const,
      state: 'active' as const,
      title: 'Maintenance needs recovery',
      detail: 'The optimized copy did not match the source digest. The original store is intact.',
      firstSeenAt: at,
      lastSeenAt: at,
      lastTransitionAt: at,
      acknowledgedAt: null,
      recoveredAt: null,
      notificationEligible: true,
    };
    const recovered = {
      ...alert,
      id: 'visual-recovered-gap',
      deduplicationKey: 'collection-gap:visual-recovered',
      kind: 'collection-gap' as const,
      severity: 'notice' as const,
      state: 'recovered' as const,
      title: 'Salidium missed some activity',
      detail: 'A period of agent activity went unrecorded.',
      recoveryTitle: 'Salidium is recording everything again',
      recoveryDetail: 'Collection is complete from here on.',
      acknowledgedAt: null,
      recoveredAt: at,
    };
    overview.health.overall = 'critical';
    overview.health.maintenance = {
      version: 1,
      operationId: 'visual-audit',
      kind: 'storage-optimize',
      phase: 'failure',
      startedAt: at,
      updatedAt: at,
      progress: 0.65,
      message: 'Verification stopped before replacement.',
      failure: 'Logical digest mismatch; source store preserved.',
    };
    overview.alerts = {
      contractVersion: 1,
      observedAt: at,
      active: [alert],
      recent: [alert, recovered],
    };
    await route.fulfill({ response, json: overview });
  });

  await openSalidium(page, daemon);
  const narrow = testInfo.project.name.includes('narrow');
  if (narrow) await page.getByRole('button', { name: 'Hide the session list' }).click();
  await page.getByRole('button', { name: 'Ingest & Storage', exact: true }).click();
  const ingest = page.getByRole('complementary', { name: 'Ingest & Storage' });

  /*
   * Every state a reader sees here is in words, not in the enum that produced it.
   *
   * The badge printed `health.overall` straight through, so a critical store said "critical" in
   * lower case beside a heading that says "Needs attention"; the maintenance row printed
   * "failure · 65%"; and an alert's only state line was "notice · recovered".
   */
  await expect(ingest.getByText('Critical', { exact: true })).toBeVisible();
  await expect(ingest.getByText('Maintenance needs recovery')).toBeVisible();
  await expect(ingest.getByText('The original store is intact.')).toBeVisible();
  await expect(ingest.getByText('Verification stopped before replacement.')).toBeVisible();
  await expect(ingest.getByText('Did not finish · 65%', { exact: true })).toBeVisible();
  await expect(ingest.getByRole('progressbar', { name: 'Maintenance progress' })).toHaveAttribute(
    'value',
    '0.65',
  );
  await expect(ingest.getByText('Needs attention now', { exact: true })).toBeVisible();

  /*
   * A resolved alert is shown in its own words rather than the ones that raised it.
   *
   * The row rendered `title` and `detail` whatever the state, so the recovered entry repeated the
   * problem in the present tense and differed from an active one by a CSS class. The macOS
   * notification had the same fault from the same source: "Recovered: The durable queue is
   * growing".
   */
  await expect(ingest.getByText('Recently resolved')).toBeVisible();
  await expect(ingest.getByText('Salidium is recording everything again')).toBeVisible();
  await expect(ingest.getByText('Collection is complete from here on.')).toBeVisible();
  await expect(ingest.getByText('Salidium missed some activity')).toHaveCount(0);
  await expect(ingest.getByText('Over', { exact: true })).toBeVisible();
  await expect(ingest.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
  await ingest.getByText('Maintenance needs recovery').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('operations-critical-alert.png'),
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await ingest.getByText('Verification stopped before replacement.').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('operations-maintenance-failure.png'),
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBe(0);
  await expectNoA11yViolations(page);
});

test('operations mutations expose pending and failed action states without an unhandled error', async ({
  page,
  daemon,
}) => {
  let finishReset = () => undefined;
  const resetReleased = new Promise<void>((resolve) => {
    finishReset = resolve;
  });
  await page.route('**/api/operations/config*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    await resetReleased;
    await route.fulfill({ status: 500, body: 'reset failed' });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await openSalidium(page, daemon);
  if (page.viewportSize()?.width === 390) {
    await page.getByRole('button', { name: 'Hide the session list' }).click();
  }
  await page.getByRole('button', { name: 'Ingest & Storage', exact: true }).click();
  const ingest = page.getByRole('complementary', { name: 'Ingest & Storage' });
  const policy = ingest.getByRole('button', { name: 'Local policy' });
  if ((await policy.getAttribute('aria-expanded')) !== 'true') await policy.click();
  const reset = ingest.getByRole('button', { name: 'Restore shipped defaults' });
  await expect(reset).toBeEnabled();
  await reset.click();

  await expect(ingest.getByText('Restoring shipped defaults')).toBeVisible();
  await expect(reset).toBeDisabled();
  finishReset();
  await expect(ingest.getByRole('alert')).toContainText(
    'Action not completed. request failed: 500',
  );
  await expect(reset).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test('a compact desktop keeps Personalize visible and its editor inside the report', async ({
  page,
  daemon,
}, testInfo) => {
  test.skip(testInfo.project.name.includes('narrow'), 'compact desktop breakpoint');
  const reset = await fetch(`${daemon.url}/api/settings/explainer`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cadence: 'off' }),
  });
  expect(reset.ok).toBe(true);
  await page.setViewportSize({ width: 886, height: 942 });
  await openSalidium(page, daemon);

  const sessions = page.getByRole('dialog', { name: 'Salidium' });
  await sessions.getByRole('button', { name: 'Hide the session list' }).click();
  const personalizeControl = page
    .locator('.toolbar')
    .getByRole('button', { name: 'Personalize', exact: true });
  await expect(personalizeControl).toBeVisible();
  await expect(personalizeControl.locator('svg')).toHaveCount(1);
  const personalize = page.getByRole('region', { name: 'Generated explanation' });
  await personalizeControl.click();
  await expect(personalize.getByLabel('Terms and examples')).toBeVisible();
  await expect(personalize.getByRole('button', { name: 'Save terms', exact: true })).toBeVisible();

  const layout = await personalize.locator('.ex-personalize').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      right: Math.round(innerWidth - rect.right),
      width: Math.round(rect.width),
      inspector: document.querySelectorAll('.inspector').length,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(layout.width).toBeLessThanOrEqual(512);
  expect(layout.right).toBeGreaterThan(0);
  expect(layout.inspector).toBe(0);
  expect(layout.overflow).toBe(0);

  await page.setViewportSize({ width: 320, height: 568 });
  await expect(personalize.getByLabel('Terms and examples')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBe(0);
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
