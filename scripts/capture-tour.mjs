/*
 * Captures the animated tour the README leads with.
 *
 * Like `capture-demo.mjs` and `capture-docs.mjs`, it boots the same seeded daemon and drives the
 * real interface, so the moving picture is the running product rather than a recording somebody
 * made once. Each beat is a still taken through the same shutter the other scripts use, and the
 * stills are assembled into a GIF afterwards; nothing is screen-recorded.
 *
 *   node scripts/capture-tour.mjs
 *
 * Stills rather than video, for the reason the rest of this pipeline exists: a recording is a
 * function of how fast the machine was that day, and two runs of it would never agree. Discrete
 * frames, each held until two consecutive screenshots match, make the GIF a function of the seed.
 *
 * ffmpeg does the assembly and has to come from the machine. Playwright ships one, but it is built
 * `--disable-everything` for the single job of muxing webm, with no GIF muxer and no `palettegen`
 * or `paletteuse` filter, so it cannot write this file. Set `SALIDIUM_FFMPEG` to point at another.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { captureContext, steady } from './capture-context.mjs';
import { CAPTURE_INSTANT, startDemo } from './demo-daemon.mjs';

const OUT = fileURLToPath(new URL('../apps/site/public/', import.meta.url));

/*
 * One tour per theme, under stable names, because a README is read in whichever theme the reader
 * set. Every other picture in this repository comes as a light and a dark, and a light-only tour
 * above a theme-aware screenshot was the one place the pair broke.
 */
const THEMES = ['light', 'dark'];

/*
 * 1280 wide, which is the narrowest window that still shows the product the way a desktop reader
 * meets it. The session list is a fixed 288px and the report column carries a container query at
 * 860px: at 1200 the column lands at 842 and the flow diagram stacks into a single column, which
 * is a layout nobody with a real window sees. Measured, not guessed.
 *
 * Captured at deviceScaleFactor 1. A GIF has 256 colours and no compression worth the name, so a
 * retina capture costs four times the bytes to be displayed at the same size in a README.
 */
const VIEWPORT = { width: 1280, height: 860 };

/* Centiseconds, which is the only unit a GIF can express a delay in. */
const HOLD = 220;
const STEP = 14;

/*
 * The tour, in the order a person actually works: read the verdict, check the working behind it,
 * read the line the agent wrote, then wind the report back to what it said earlier.
 *
 * Every beat reloads first. Driving one page through the whole sequence meant each beat depended
 * on the previous one having closed cleanly, and a panel that stayed open put half of one surface
 * into the picture of the next.
 */
const BEATS = [
  {
    name: 'report',
    /* The page as it opens, session list and all. */
  },
  {
    name: 'wide',
    /*
     * The list folded away with the key the product binds for it, which is the same thing
     * `capture-demo.mjs` does for the link card. It is a beat rather than a setup step: it shows a
     * control worth knowing about, and it gives the panels after it the width they need.
     */
    fold: true,
  },
  {
    name: 'evidence',
    fold: true,
    click: 'Evidence',
    /* The coverage grid, once it has drawn: every square is a file and carries its own check in a
     * title. Waiting on the word "Coverage" instead matched a session title in the folded list. */
    waitFor: "[role='dialog'] [title*='tests passed']",
  },
  {
    name: 'record',
    fold: true,
    click: 'Evidence',
    waitFor: "[role='dialog'] [title*='tests passed']",
    /*
     * Reached by pressing a file in the coverage grid rather than through the History rail.
     * History is a full-height column down the right edge, so a record opened from it left two
     * panels competing for the same corner and the picture read as clutter. A square in the grid
     * is the same drill-through from a surface that is already centred.
     */
    next: {
      clickSelector: "[role='dialog'] [title*='tests passed']",
      waitFor: 'Provider record',
    },
    /*
     * Then the Evidence panel is shut from behind the record it opened. Two panels over one report
     * is the picture a reader has to untangle before they can read either, and the beat is about
     * the record. `.first()` is the Evidence panel: it is open before the drawer and so precedes
     * it in the document, and the wait below is on its coverage grid being gone rather than on a
     * dialog count, which both of them satisfy.
     */
    close: {
      clickSelector: "[title='Close (Esc)']",
      waitFor: "[role='dialog'] [title*='tests passed']",
      state: 'hidden',
    },
  },
  {
    name: 'rewind',
    fold: true,
    click: 'Rewind',
    /* The scrubber's own legend depends on whether the session is following live, so wait on the
     * element rather than on a word that is only one of three it might print. */
    waitFor: ".rewind input[type='range']",
    /*
     * Dragged off the end and back, a frame at a time, as `[position, how long it is held]`. Left
     * alone the scrubber says "following live", which is the one state that shows nothing of what
     * it is for, and the intermediate positions are what make this beat move rather than cut.
     *
     * It returns because of what the far end looks like. The explanation is the last event in this
     * session, so any real scrub takes it away and two thirds of the frame is then the empty
     * "No explanation yet" panel. That frame earns its place - the verdict behind it flips from
     * "4 files changed, unverified" to a green check that had passed at the time, which is the
     * whole point of winding a report back - but it is not a picture to leave a reader looking at.
     */
    scrub: [
      [0.94, STEP],
      [0.86, STEP],
      [0.78, STEP],
      [0.7, STEP],
      [0.62, 150],
      [0.78, STEP],
      [0.94, HOLD],
    ],
  },
];

function ffmpeg() {
  const candidates = [process.env.SALIDIUM_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['-hide_banner', '-muxers'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    if (!/^\s*\S*E\s+gif\s/m.test(probe.stdout)) continue;
    return bin;
  }
  throw new Error(
    'no ffmpeg with a GIF muxer found. Install one, or set SALIDIUM_FFMPEG to its path. ' +
      "Playwright's bundled ffmpeg is built without GIF support and cannot be used.",
  );
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${bin} failed:\n${result.stderr}`);
}

const bin = ffmpeg();
const work = await mkdtemp(join(tmpdir(), 'salidium-tour-'));
await mkdir(OUT, { recursive: true });

const demo = await startDemo({ at: CAPTURE_INSTANT });
const browser = await chromium.launch();

/**
 * Drives the whole tour once and returns each still with how long it is held, in centiseconds.
 */
async function shoot(theme) {
  /* Each entry is one still and how long it is held. */
  const frames = [];

  const context = await captureContext(browser, demo, {
    /* See VIEWPORT. `captureContext` defaults to 2 for the stills, which a GIF cannot afford. */
    deviceScaleFactor: 1,
    viewport: VIEWPORT,
    colorScheme: theme,
  });
  const page = await context.newPage();

  const frame = async (beat, hold) => {
    /* Numbered and named, so a frame that came out wrong says which beat produced it. */
    const file = join(work, `${theme}-${String(frames.length).padStart(3, '0')}-${beat.name}.png`);
    await writeFile(file, await steady(page));
    frames.push({ file, hold });
  };

  for (const [index, beat] of BEATS.entries()) {
    /*
     * Reloaded rather than navigated, and not on `networkidle`, which the event stream never
     * reaches because it holds a connection open for the life of the page.
     *
     * `demo.url` carries the token in the hash, so every beat after the first asked for a URL that
     * differed from the current one by nothing at all: the browser treated it as a fragment change,
     * kept the document, and the panel the previous beat had opened was still over the page when
     * the next one tried to click through it.
     */
    if (index === 0) await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    /* Wait on something the page renders before the beat is set up, not on what a click is about
     * to reveal: waiting for that only ever timed out. */
    await page.getByText('4 files changed, unverified').waitFor({ timeout: 20_000 });

    /*
     * The session list, reconciled rather than toggled.
     *
     * Whether it is folded survives a reload, so a beat that pressed the key unconditionally
     * turned it back on for every beat after the one that folded it. Asking for a state and
     * setting it only when it differs is the only version of this that composes.
     *
     * The heading is clicked first because a reload leaves the keypress with nowhere to land until
     * something in the document has focus. Clicking a title is inert, and `[` is the binding the
     * product documents, so the beat is the shortcut a reader would use.
     */
    const wantList = !beat.fold;
    if ((await page.locator('.side').isVisible()) !== wantList) {
      await page.locator('.masthead h1').first().click();
      await page.keyboard.press('[');
      await page
        .locator('.side')
        .waitFor({ state: wantList ? 'visible' : 'hidden', timeout: 5_000 });
    }

    const steps = [beat, beat.next, beat.close];
    for (const step of steps.filter((s) => s && (s.click || s.clickSelector))) {
      const control = step.clickSelector
        ? page.locator(step.clickSelector)
        : page.getByRole('button', { name: step.click, exact: false });
      /*
       * The last match, where a step asks for it. The History rail opens scrolled to its most
       * recent entry, so the first `record` link in the document is several screens above the
       * fold; reaching it scrolled the rail somewhere it does not open, and the picture behind the
       * record was then a part of the history no reader had asked for.
       */
      await (step.pick === 'last' ? control.last() : control.first()).click();
      const after = /^[.[#]/.test(step.waitFor)
        ? page.locator(step.waitFor)
        : page.getByText(step.waitFor);
      await after.first().waitFor({ state: step.state ?? 'visible', timeout: 10_000 });
    }

    if (!beat.scrub) {
      /* A panel measured in the frame it opens in reports the box it started at, not the one it
       * settles into. The shutter will not accept a frame until two agree, so this only decides
       * how soon it starts asking. */
      await page.waitForTimeout(350);
      await frame(beat, HOLD);
      continue;
    }

    const range = page.locator("input[type='range']").first();
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    for (const [at, hold] of beat.scrub) {
      await page.mouse.move(box.x + box.width * at, box.y + box.height / 2, { steps: 6 });
      await frame(beat, hold);
    }
    await page.mouse.up();
  }

  await context.close();
  return frames;
}

/**
 * Assembles one theme's stills into a GIF, and returns the file it wrote.
 */
async function assemble(theme, frames) {
  /*
   * The concat demuxer, because a GIF wants a different delay on the beats than on the scrub and a
   * constant frame rate cannot give it one. The last entry is repeated: concat takes a duration
   * from the line that follows the file, so without it the final frame is shown for a single tick.
   */
  const listFile = join(work, `${theme}.txt`);
  await writeFile(
    listFile,
    `${frames
      .map(({ file, hold }) => `file '${file}'\nduration ${(hold / 100).toFixed(2)}`)
      .concat(`file '${frames.at(-1).file}'`)
      .join('\n')}\n`,
  );

  /*
   * One palette per tour, from every frame rather than the first. `stats_mode=diff` weighs the
   * pixels that change, which is where a shared palette otherwise spends its colours worst: the
   * interface is mostly one flat background, and a palette fitted to the whole frame gave the
   * greys two hundred entries and the diagrams the rest.
   */
  const palette = join(work, `${theme}-palette.png`);
  run(bin, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    'palettegen=stats_mode=diff',
    palette,
  ]);

  /*
   * `dither=none` on the way out. Dithering a flat interface trades a banding problem it does not
   * have for a noise problem it does, and the noise lands in the text and in every frame's diff.
   */
  const file = join(OUT, `tour-${theme}.gif`);
  run(bin, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-i',
    palette,
    '-lavfi',
    'paletteuse=dither=none:diff_mode=rectangle',
    '-fps_mode',
    'vfr',
    '-loop',
    '0',
    file,
  ]);
  return file;
}

try {
  for (const theme of THEMES) {
    const frames = await shoot(theme);
    const file = await assemble(theme, frames);
    const { size } = statSync(file);
    const kb = (size / 1024).toFixed(0);
    console.log(
      `wrote ${file}  ${frames.length} frames  ${VIEWPORT.width}x${VIEWPORT.height}  ${kb} KB`,
    );
    /*
     * A README opens with this, so its weight is part of the first impression rather than a
     * detail. The number is a judgement someone made, not a limit the format imposes, so it warns
     * rather than failing: a tour that has grown past it needs fewer beats or a smaller window.
     */
    if (size > 1_500_000) console.log('that is large for a README; consider fewer beats');
  }
} finally {
  await browser.close();
  await demo.stop();
  await rm(work, { recursive: true, force: true });
}
