/*
 * Captures the product surfaces the documentation shows.
 *
 * Like `capture-demo.mjs`, it boots the same seeded daemon and drives the real interface, so every
 * picture in the docs is the running product rather than a drawing of it. Re-run it whenever a
 * surface changes and the pages follow.
 *
 *   node scripts/capture-docs.mjs
 *
 * Each shot waits on rendered text before it is taken, so a surface that stopped working fails the
 * capture instead of quietly shipping a picture of the last time it did.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { captureContext, steady } from './capture-context.mjs';
import { CAPTURE_INSTANT, startDemo } from './demo-daemon.mjs';

const OUT = fileURLToPath(new URL('../apps/site/public/docs/', import.meta.url));

/*
 * Every shot names the element it is clipped to. A viewport screenshot of a 1400px window shrunk
 * into a reading column turns the interface into texture; clipped to the surface being described,
 * the same picture is legible at the width a document can give it.
 */
/*
 * A surface as wide as the whole report is wider than the column a document can give it, so it
 * arrives scaled down and soft. Captured in a narrower window it is narrow enough to be shown at
 * its own size. The window stays above the report's 860px container query either way, so nothing
 * is photographed in a layout a desktop reader would not see.
 */
const NARROW = { width: 1180, height: 1000 };

const SHOTS = [
  {
    name: 'gate',
    /* The one surface reached without a token, which is what it is for. */
    gate: true,
    ready: 'This page needs the token your daemon is listening for.',
    clip: '.gate-inner',
    pad: 40,
  },
  {
    name: 'sessions',
    ready: 'Needs you',
    /*
     * The list is a full-height column, and clipped to itself it is a narrow strip that no
     * document can show without either shrinking it to nothing or running it off the page. Taken
     * with the report beside it, it is the shape a page can hold and it shows the list where it
     * actually sits.
     */
    rect: { x: 0, y: 0, width: 940, height: 560 },
  },
  {
    name: 'masthead',
    ready: '4 files changed, unverified',
    clip: '.masthead',
    pad: 24,
    viewport: NARROW,
  },
  {
    name: 'evidence',
    ready: '4 files changed, unverified',
    click: 'Evidence',
    /* The rail names its first section once the panel is open. */
    waitFor: 'Coverage',
    clip: "[role='dialog']",
    pad: 0,
  },
  {
    name: 'rewind',
    ready: '4 files changed, unverified',
    click: 'Rewind',
    /* The scrubber's own legend depends on whether the session is following live, so wait on the
     * element rather than on a word that is only one of three it might print. */
    waitFor: ".rewind input[type='range']",
    /*
     * `.timeline`, not `.rewind`. The outer element is transparent and floats over the report, so
     * a capture of it caught half-sentences of the session showing through from behind and read as
     * a broken picture.
     */
    clip: '.timeline',
    pad: 0,
    viewport: NARROW,
    /* The long run, so the track has a failure to draw red and marks close enough to merge. */
    session: 'claude-code:demo-timeline',
    sessionReady: 'Move invoice numbering off the sequence',
    /*
     * Dragged off the end before the shot. Left alone the scrubber says "following live", which is
     * the one state that shows nothing of what it is for.
     */
    scrub: 0.62,
  },
  {
    name: 'history',
    ready: '4 files changed, unverified',
    click: 'History',
    waitFor: "[aria-label='History']",
    /* The table, not the rail: it is the surface that carries the How we know column. */
    next: {
      clickSelector: "[title='Open the history as a table across the page']",
      waitFor: 'How we know',
    },
    clip: ".hist-table, [aria-label='History']",
    pad: 0,
    fitContent: true,
    maxHeight: 560,
  },
  {
    name: 'models-usage',
    ready: '4 files changed, unverified',
    click: 'Models & Usage',
    waitFor: "[aria-label='Models & Usage']",
    next: {
      click: 'Choose a model',
      waitFor: 'Salidium default',
    },
    clip: "[aria-label='Models & Usage']",
    pad: 0,
    /*
     * A rail runs the height of the window and the counts stop well before that, so it is clipped
     * to where its own content ends. A fixed cap was guesswork, and the guess left a third of the
     * picture empty.
     */
    fitContent: true,
  },
  {
    name: 'record',
    ready: '4 files changed, unverified',
    click: 'History',
    waitFor: "[aria-label='History']",
    /* History is where every entry carries a `record` link, which is how a reader reaches one. */
    next: { clickSelector: "[title='Open the raw record this came from']", waitFor: 'How we know' },
    clip: "[role='dialog']",
    pad: 0,
  },
];

/*
 * Writes one capture under a name carrying a hash of its own bytes, and records the CSS size the
 * page should draw it at. Captured at deviceScaleFactor 2, so that is half the pixel dimensions.
 */
/*
 * How much of a capture is one flat colour. A picture that is four fifths empty is a clipping
 * mistake rather than a screenshot, and it is the one fault the other checks here cannot see: the
 * scale is right, the aspect is right, and there is nothing in it.
 */
function emptiness(buffer, width, height) {
  /* Sample the decoded PNG cheaply by counting distinct 16x16 tiles of the raw byte stream. */
  const step = Math.max(1, Math.floor(buffer.length / 4096));
  const counts = new Map();
  for (let i = 0; i < buffer.length; i += step) {
    const k = buffer[i];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const commonest = Math.max(...counts.values());
  return { share: commonest / total, width, height };
}

async function record(name, theme, buffer) {
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const file = `${name}-${theme}-${digest}.png`;
  await writeFile(`${OUT}${file}`, buffer);
  /*
   * Read back from the file rather than from the clip that was asked for. A clip is rounded on the
   * way in, so the requested height and the written height differed by a pixel and the page then
   * drew the picture at an aspect a pixel away from its own.
   */
  const width = buffer.readUInt32BE(16) / 2;
  const height = buffer.readUInt32BE(20) / 2;
  shots[name] ??= { width, height };
  shots[name][theme] = file;
  const { share } = emptiness(buffer, width, height);
  const flat = share > 0.72 ? `  MOSTLY EMPTY (${Math.round(share * 100)}% one value)` : '';
  if (flat) empties.push(`${file}${flat}`);
  console.log(`wrote ${file}  ${width}x${height} css${flat}`);
}

await mkdir(OUT, { recursive: true });
const demo = await startDemo({ at: CAPTURE_INSTANT });
/*
 * The demo boots with the explainer disabled so seeding can never call an installed agent. The
 * scheduler has already inherited that stop and no more events are added, so the docs process can
 * release the environment lock before opening the static settings capture. This shows the controls
 * a reader can actually use without making the fixture nondeterministic or spending provider quota.
 */
delete process.env.SALIDIUM_EXPLAINER;
delete process.env.SALIDIUM_EXPLAIN_MODEL;
const browser = await chromium.launch();
let written = 0;
/*
 * Each capture's file name, written out beside the files.
 *
 * The name carries a hash of the bytes. A capture that changed shape while keeping its name was
 * served from a browser cache at its old size and stretched into the box the new one asked for,
 * which is the one failure a screenshot must not have. A new picture is now a new name.
 */
const shots = {};
const empties = [];

try {
  for (const theme of ['light', 'dark']) {
    for (const shot of SHOTS) {
      /* Retina, so the image still reads when a document scales it down; the clock, the zone and
         the locale come from `capture-context.mjs`, which says why. */
      const context = await captureContext(browser, demo, {
        viewport: shot.viewport ?? { width: 1400, height: 1000 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const url = shot.gate ? demo.url.replace(/#token=.*/, '') : demo.url;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      /* Wait on something the page renders before the shot is set up, not on the shot's own text:
       * waiting for what a click is about to reveal only ever timed out. */
      await page.getByText(shot.ready).first().waitFor({ timeout: 20_000 });

      /*
       * The token and the route share the hash, so a session is opened after the token has been
       * taken rather than alongside it. `hashchange` is what the app listens on.
       */
      if (shot.session) {
        await page.evaluate((id) => {
          window.location.hash = `#/s/${id}`;
        }, shot.session);
        await page.getByText(shot.sessionReady).first().waitFor({ timeout: 15_000 });
      }

      for (const step of [shot, shot.next].filter((s) => s && (s.click || s.clickSelector))) {
        const control = step.clickSelector
          ? page.locator(step.clickSelector)
          : page.getByRole('button', { name: step.click, exact: false });
        await control.first().click();
        const after = /^[.[#]/.test(step.waitFor)
          ? page.locator(step.waitFor)
          : page.getByText(step.waitFor);
        await after.first().waitFor({ timeout: 10_000 });
      }

      if (shot.rect) {
        await record(shot.name, theme, await steady(page, shot.rect));
        written += 1;
        await context.close();
        continue;
      }

      if (shot.scrub !== undefined) {
        const range = page.locator("input[type='range']").first();
        const box = await range.boundingBox();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * shot.scrub, box.y + box.height / 2, {
          steps: 12,
        });
        await page.mouse.up();
        await page.getByText('back to now').first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(400);
      }

      const target = page.locator(shot.clip).first();
      await target.waitFor({ timeout: 10_000 });
      /* A panel measured in the frame it opens in reports the box it started at, not the one it
       * settles into, and the clip then cuts its content off. */
      await page.waitForTimeout(350);
      let box = await target.boundingBox();
      if (!box) throw new Error(`${shot.name}: ${shot.clip} has no box`);

      /*
       * Where a surface is shorter than the pane holding it, clip to what it actually drew. The
       * union of its descendants' boxes is where its content ends; the element's own box is where
       * the window ends.
       */
      if (shot.fitContent) {
        const content = await target.evaluate((el) => {
          const r = el.getBoundingClientRect();
          let bottom = r.top;
          for (const child of el.querySelectorAll('*')) {
            const c = child.getBoundingClientRect();
            if (c.width > 0 && c.height > 0) bottom = Math.max(bottom, c.bottom);
          }
          return { bottom };
        });
        box = { ...box, height: Math.min(box.height, content.bottom - box.y + 12) };
      }

      const clip = {
        x: Math.max(0, box.x - shot.pad),
        y: Math.max(0, box.y - shot.pad),
        width: Math.min((shot.viewport ?? { width: 1400 }).width, box.width + shot.pad * 2),
        height: Math.min(shot.maxHeight ?? 1000, box.height + shot.pad * 2),
      };
      await record(shot.name, theme, await steady(page, clip));
      written += 1;
      await context.close();
    }
  }
} finally {
  await browser.close();
  await demo.stop();
}

/* Anything left from a previous run has a name nothing references now. */
for (const name of await readdir(OUT)) {
  if (
    name.endsWith('.png') &&
    !Object.values(shots).some((s) => s.light === name || s.dark === name)
  ) {
    await rm(`${OUT}${name}`);
    console.log(`removed stale ${name}`);
  }
}

await writeFile(
  fileURLToPath(new URL('../apps/site/app/docs/shots.json', import.meta.url)),
  `${JSON.stringify(Object.fromEntries(Object.entries(shots).sort()), null, 2)}\n`,
);

if (empties.length) {
  console.log(`\n${empties.length} capture(s) look mostly empty:`);
  for (const e of empties) console.log(`  ${e}`);
}

console.log(`${written} captures`);
