import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const workerPromise = import(workerUrl.href).then(({ default: worker }) => worker);

async function fetchSite(url, headers = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(url, { headers }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

/*
 * These guards encode the patterns this site is not allowed to grow back, rather than the exact
 * wording of whatever was on the page last. The previous version of this file had accumulated a
 * dozen `doesNotMatch` assertions naming copy from four removed designs, which made it a record of
 * what had been tried instead of a statement of what is true.
 */
function assertHouseRules(html, where) {
  // Em dashes never reach public copy.
  assert.doesNotMatch(html, /—/, `${where}: em dash`);

  // Rejected controls: tabs and pill selectors, native dropdowns, disclosure widgets.
  assert.doesNotMatch(html, /aria-pressed/i, `${where}: pill or tab selector`);
  assert.doesNotMatch(html, /<select/i, `${where}: select`);
  assert.doesNotMatch(html, /<details/i, `${where}: details`);

  // Rejected motion: no video, no playback affordances, no carousel paging.
  assert.doesNotMatch(html, /<video/i, `${where}: video`);
  // Control labels, not prose: "the previous total" is a sentence, not a carousel button.
  assert.doesNotMatch(
    html,
    /Pause demo|Play demo|aria-label="(Pause|Play|Previous|Next)\b/i,
    `${where}: playback control`,
  );

  // Salidium's own engineering is not a marketing example.
  assert.doesNotMatch(
    html,
    /cursorOffset|cursor-gap|resnapshot|SessionCoordinator|transcriptTailer|durable storage|schema migration|hook collision/i,
    `${where}: internal engineering example`,
  );

  // "Open core" is not the marketing label.
  assert.doesNotMatch(html, /open core/i, `${where}: open core label`);
}

test("server-renders the Salidium landing page", async () => {
  const response = await fetchSite("http://localhost/", { accept: "text/html" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Salidium: Agent output, turned into a visual report<\/title>/i);

  // The claim, preserved verbatim. It is the only line of copy in the left panel.
  assert.match(html, /Agent output, turned into a visual report\./);
  assert.match(html, /npx salidium/);

  // One command, one control. The npx/pnpm selector is gone.
  assert.doesNotMatch(html, /pnpm dlx/);

  // The product is on the page, in both themes, and it is a real capture rather than a drawing.
  assert.match(html, /class="shot shot-light" src="\/report-light\.png"/);
  assert.match(html, /class="shot shot-dark" src="\/report-dark\.png"/);
  assert.match(html, /alt="The Salidium interface[^"]+"/);
  /*
   * Both captures carry intrinsic dimensions so the panel does not reflow when they arrive. The
   * numbers are not pinned: the capture is clipped to the report, so its height moves whenever the
   * report does, and asserting today's value would only ever fail for the wrong reason.
   */
  for (const shot of ["shot-light", "shot-dark"]) {
    assert.match(
      html,
      new RegExp(`class="shot ${shot}"[^>]*width="\\d+"[^>]*height="\\d+"`),
      `${shot} is missing intrinsic dimensions`,
    );
  }

  // Three ways in, in order: the thing to do, then the two things to read.
  assert.match(
    html,
    /Easy, one line install[\s\S]*Clear, complete documentation[\s\S]*Open source, every line/,
  );
  assert.equal(html.match(/class="panel cell/g)?.length, 3);

  /*
   * Every cell renders both states in the markup, not only on hover: the reveal is a progressive
   * nicety, and what a cell does has to be readable without a pointer and without JavaScript.
   */
  assert.equal(html.match(/class="cell-swap-alt"/g)?.length, 3);
  assert.match(html, /class="cell-swap-alt"[\s\S]{0,80}npx salidium/);
  assert.match(html, /Open the docs/);
  assert.match(html, /Go to GitHub/);
  assert.match(html, /<a [^>]*href="\/docs"[^>]*>/);
  assert.match(html, /<a [^>]*github\.com\/twinkling-reality\/salidium[^>]*>/);

  /*
   * No top bar on the home page: with two destinations and a switch, a full-width strip above the
   * fold spent a band of the screen on three words.
   */
  assert.doesNotMatch(html, /class="site-head/);

  // The theme control is the one icon-only thing, so it carries its name in a label.
  assert.match(html, /class="theme-toggle"[\s\S]{0,200}aria-label="Switch to dark theme"/);

  assert.match(html, /rel="canonical" href="https:\/\/salidium\.com\/?"/);
  assert.match(html, /property="og:url" content="https:\/\/salidium\.com\/?"/);
  assert.match(html, /data-theme="light"/);
  assert.match(html, /localStorage\.getItem\("salidium-site-theme"\)/);

  // Five rail controls precede the content, so there is a way past them.
  assert.match(html, /class="skip-link" href="#main"/);
  assert.equal(html.match(/<h1/g)?.length, 1);

  assertHouseRules(html, "home");
});

test("server-renders first-party Salidium docs", async () => {
  const response = await fetchSite("http://localhost/docs", { accept: "text/html" });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Salidium Docs<\/title>/i);
  assert.match(html, /aria-label="Salidium home"[\s\S]*brand-divider[\s\S]*brand-section">Docs/);
  assert.match(html, /Set up Salidium/);
  assert.match(html, /Node 24 or newer[\s\S]*npx salidium/);

  // The two trust levels stay separated: derived facts, then generated explanation.
  assert.match(html, /Derived from the record[\s\S]*Generated, and labelled as such/);
  assert.match(html, /A command name is not proof/);
  assert.match(
    html,
    /Turn generated explanations off and Changed, Verified, Left, Needs you/,
  );

  assert.match(html, /never leave your machine/);
  assert.match(html, /SALIDIUM_EXPLAINER=off/);
  assert.match(html, /Salidium says unknown[\s\S]*rather than guessing/);
  assert.match(html, /Windows[\s\S]*history works[\s\S]*live updates during a run do not/);
  assert.match(
    html,
    /salidium doctor[\s\S]*salidium status[\s\S]*salidium restart[\s\S]*salidium stop/,
  );

  // The eyebrow above the docs title is gone.
  assert.doesNotMatch(html, /translation-label/);

  assertHouseRules(html, "docs");
});

test("redirects www requests to the canonical HTTPS domain", async () => {
  const response = await fetchSite("https://www.salidium.com/docs?source=www");

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://salidium.com/docs?source=www");
});
