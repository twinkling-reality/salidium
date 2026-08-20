/*
 * What both capture scripts have to agree about for a picture to be reproducible.
 *
 * The site's claim is that its images are the running product, and a claim like that is only worth
 * anything if the same product produces the same image. Measured on 2026-08-20, it did not: five
 * of the eight documentation shots changed their bytes between two runs with no code change
 * between them, so a real capture change and noise looked exactly alike and neither could be
 * committed with confidence.
 *
 * Three things were moving, and they are all answered here or in `demo-daemon.mjs`:
 *
 *   the fixture's own clock   pinned to `CAPTURE_INSTANT`, so relative and absolute labels alike
 *                             are a function of the seed rather than of when the run started
 *   the machine's zone/locale pinned, because the product prints clock times through
 *                             `toLocaleTimeString` and would otherwise photograph differently on
 *                             every machine that regenerated
 *   the shutter               `steady` below, which will not accept a frame until the surface has
 *                             stopped changing
 *
 * The fourth was the daemon's own explainer appending generated events to the fixture after it had
 * been seeded; that is answered where the fixture is written.
 */

/**
 * A browser context that reads the fixture's clock rather than the machine's.
 *
 * `setFixedTime` pins what the page reads as now and leaves timers running, so the interface still
 * ticks; the alternative, installing a fake clock, stops the intervals the app schedules and would
 * photograph a product that had quietly stopped working.
 */
export async function captureContext(browser, demo, options) {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    ...options,
  });
  await context.clock.setFixedTime(demo.now);
  return context;
}

/**
 * Takes the shot twice and keeps it only once two frames agree.
 *
 * The alternative is a guess about how long a surface takes to settle, and the guess was simply
 * missing from one path: the session list is clipped to a rectangle rather than to an element, so
 * it skipped the wait the other shots have and was photographed the instant its first words
 * appeared, with the report beside it still painting. Two identical frames is the property these
 * scripts actually want from every shot, and one extra screenshot is what it costs to ask for it
 * rather than to hope for it.
 *
 * A surface that never settles fails the capture rather than shipping whichever frame it caught.
 */
export async function steady(page, clip) {
  let previous;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const shot = await page.screenshot(clip ? { clip } : {});
    if (previous?.equals(shot)) return shot;
    previous = shot;
    await page.waitForTimeout(120);
  }
  throw new Error('capture never settled: two consecutive frames never matched');
}
