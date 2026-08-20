/*
 * Captures the product screenshots the site uses.
 *
 * It boots the same seeded daemon the browsable demo uses, drives the real interface, and writes
 * PNGs into apps/site/public. Re-run it whenever the report changes and the site's images follow,
 * which is the only reason to have a script rather than a folder of stills someone took once.
 *
 *   node scripts/capture-demo.mjs
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// @playwright/test is the workspace dependency; it re-exports the browser drivers.
import { chromium } from '@playwright/test';
import { startDemo } from './demo-daemon.mjs';

const OUT = fileURLToPath(new URL('../apps/site/public/', import.meta.url));

const shots = [
  { name: 'report-light', colorScheme: 'light' },
  { name: 'report-dark', colorScheme: 'dark' },
];

await mkdir(OUT, { recursive: true });
const demo = await startDemo();
const browser = await chromium.launch();

try {
  for (const shot of shots) {
    const context = await browser.newContext({
      /*
       * The report column has a container query at 860px: below it the flow diagram stacks into a
       * single column and the converging lanes lose the shape that makes them worth drawing. The
       * sidebar takes about 500px, so the window has to stay above ~1360 for the diagram to lay
       * out the way it does on a real desktop. The site displays this large enough to read.
       */
      /*
       * Portrait, to match the panel it sits in. The panel is roughly 0.8 wide-to-tall on a
       * desktop window, and a 1.4 landscape capture cropped most of the report away filling it.
       * A tall window also shows more of the report, which is the thing worth showing.
       */
      viewport: { width: 1400, height: 1780 },
      // Retina, so the image still reads when it is scaled down into a layout.
      deviceScaleFactor: 2,
      colorScheme: shot.colorScheme,
    });
    const page = await context.newPage();
    // Not `networkidle`: the event stream holds a connection open for the life of the page, so it
    // never goes idle. The content waits below are the real signal anyway.
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });

    // Wait for the derived report, not a timer: the verdict only renders once state has folded.
    await page.getByText('4 files changed, unverified').waitFor({ timeout: 15_000 });
    await page.getByText('Some customers were charged twice').waitFor({ timeout: 15_000 });

    /*
     * Clip to where the report actually ends. The window has to be tall enough that nothing is cut
     * off, but the report is shorter than the window, so capturing the viewport baked a band of
     * empty page into the image and the site then had to letterbox around it.
     */
    const height = await page.evaluate(() => {
      // `.page` is the article the report is rendered into (SessionView.tsx).
      const page = document.querySelector('.session-content .page');
      const bottom = page ? page.getBoundingClientRect().bottom : window.innerHeight;
      return Math.min(Math.ceil(bottom + 28), window.innerHeight);
    });

    const file = `${OUT}${shot.name}.png`;
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1400, height } });
    console.log(`wrote ${file}`);
    await context.close();
  }

  /*
   * The link card, at the size a link card is rendered: 1200x630, which nothing else on this site
   * is. It is the same daemon and the same interface, photographed at a different window, because
   * a card drawn for the purpose would be the one image on the site that is not the product.
   *
   * The session list is folded away first. At 1200 wide it takes 500 of them, leaving the report
   * column under the 860px container query where the flow diagram stacks into a single column and
   * stops being the thing worth showing. Folded, the report gets the whole window.
   */
  const cardContext = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const cardPage = await cardContext.newPage();
  await cardPage.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await cardPage.getByText('4 files changed, unverified').waitFor({ timeout: 15_000 });
  await cardPage.keyboard.press('[');
  await cardPage.locator('.side').waitFor({ state: 'hidden', timeout: 5_000 });
  /*
   * Scoped to the report rather than matched by text. The session title is also a row in the list,
   * and once the list is folded that row is `hidden` — so a text match resolved to an element that
   * was never going to become visible and the wait ran out on a page that had already rendered.
   */
  await cardPage.locator('.masthead h1').waitFor({ timeout: 15_000 });
  const card = `${OUT}card.png`;
  await cardPage.screenshot({ path: card });
  console.log(`wrote ${card}`);
  await cardContext.close();
} finally {
  await browser.close();
  await demo.stop();
}
