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

/*
 * The documentation is one tree rendered two ways, so these check the tree's properties rather
 * than the wording of whichever draft was last on the page.
 */
const DOC_SLUGS = [
  "install",
  "the-page",
  "sessions",
  "report",
  "evidence",
  "rewind",
  "records",
  "provenance",
  "explanations",
  "local",
  "keyboard",
  "cli",
  "environment",
  "limits",
];

test("server-renders the documentation index", async () => {
  const response = await fetchSite("http://localhost/docs", { accept: "text/html" });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Salidium Docs<\/title>/i);
  assert.match(html, /Salidium documentation/);

  // Every page is in the index and in the navigation, both built from one list.
  for (const slug of DOC_SLUGS) {
    assert.equal(
      html.match(new RegExp(`href="/docs/${slug}"`, "g"))?.length,
      2,
      `${slug} should appear once in the contents and once in the navigation`,
    );
  }

  /*
   * No invented grouping. The product has no route table, no navigation and no section constant,
   * so a group name here could only be this site's opinion wearing the product's name. These three
   * were exactly that.
   */
  for (const invented of ["Going deeper", "Your machine", "The report</"]) {
    assert.doesNotMatch(html, new RegExp(invented), `docs: invented group name ${invented}`);
  }

  assertHouseRules(html, "docs index");
});

test("server-renders every documentation page, and none of them is a stub", async () => {
  for (const slug of DOC_SLUGS) {
    const response = await fetchSite(`http://localhost/docs/${slug}`, { accept: "text/html" });
    assert.equal(response.status, 200, `/docs/${slug} should render`);
    const html = await response.text();

    /*
     * A page has to be worth being a page. Half of them were once a single paragraph behind their
     * own route, which made the navigation look like a document and read like a stub.
     */
    const words = html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " ")
      .split(/\s+/)
      .filter(Boolean).length;
    assert.ok(words > 120, `/docs/${slug} has only ${words} words of content`);

    // The page's place in the set is what the navigation shows. An eyebrow above the title is not.
    assert.doesNotMatch(html, /doc-kicker/, `/docs/${slug}: eyebrow above the title`);

    assertHouseRules(html, `docs/${slug}`);
  }
});

test("documentation states what the product does, not what an earlier draft said", async () => {
  const report = await (await fetchSite("http://localhost/docs/report")).text();
  const provenance = await (await fetchSite("http://localhost/docs/provenance")).text();
  const limits = await (await fetchSite("http://localhost/docs/limits")).text();
  const install = await (await fetchSite("http://localhost/docs/install")).text();

  /*
   * All five trust classes, named as the product names them. The page used to list four and omit
   * `planned`; it then called the fifth "Generated", which is a word the interface never prints —
   * the badge on a generated line reads `explained`.
   */
  assert.match(provenance, /Observed[\s\S]*Reported[\s\S]*Derived[\s\S]*Planned[\s\S]*Explained/);

  // The seven-day import default is the likeliest first-run surprise, so it stays on the page.
  assert.match(install, /last seven days/i);
  assert.match(install, /SALIDIUM_HISTORY_DAYS/);

  /*
   * Four claims an earlier version of this page made that the product does not support. Each one
   * read perfectly well and was wrong, which is the only kind that survives a proofread.
   */
  // There is no diff anywhere in the shipped interface: `DiffView` is reachable only from
  // `ChangesSection`, which nothing renders.
  assert.doesNotMatch(report, /with the diff/i, "docs: claims the report shows a diff");
  // `partial` means the summary said pass and the exit code disagreed, not a narrowed run.
  assert.doesNotMatch(report, /ran on a subset/i, "docs: mis-defines a partial outcome");
  // The transcript tailer is platform-agnostic; Windows loses the hook relay, not live updates.
  assert.doesNotMatch(
    limits,
    /live updates during a run do not/i,
    "docs: overstates the Windows limit",
  );
  // "Changed" is a view inside Evidence, not a lane beside Verified, Left and Needs you.
  assert.doesNotMatch(report, /Changed, Verified, Left/, "docs: lists Changed as a top-level lane");
});

test("serves the docs as Markdown for anything that would rather read text", async () => {
  const response = await fetchSite("https://salidium.com/docs.md");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown\b/);

  const markdown = await response.text();
  assert.doesNotMatch(
    markdown,
    /<\/[a-z]+>|<(div|p|span|section|h[1-6])[\s>]/i,
    "markdown should carry no markup",
  );
  assert.match(markdown, /^# Salidium documentation/);
  assert.match(markdown, /^Source: https:\/\/salidium\.com\/docs$/m);
  assert.match(markdown, /```sh\nnpx salidium\n```/);
  for (const slug of DOC_SLUGS) {
    assert.match(markdown, new RegExp(`^Source: https://salidium\\.com/docs/${slug}$`, "m"));
  }

  // One page on its own, for a fetcher that wants one thing.
  const one = await fetchSite("https://salidium.com/docs/report.md");
  assert.equal(one.status, 200);
  const onePage = await one.text();
  assert.match(onePage, /^## 4\. Reading a report$/m);
  assert.doesNotMatch(onePage, /^## 1\. Install$/m);

  /*
   * The page and this file come from one tree, so a claim cannot be true in one and absent from
   * the other. Checking a few is what keeps that from being merely the intention.
   */
  const html = await (await fetchSite("http://localhost/docs/report")).text();
  for (const claim of ["A command name is not proof", "partial scope"]) {
    assert.match(onePage, new RegExp(claim));
    assert.match(html, new RegExp(claim));
  }

  assertHouseRules(markdown, "docs.md");
});

test("the machine-readable routes carry the host they were asked on", async () => {
  /*
   * Every URL in `llms.txt` and in the Markdown is absolute, and it is built from the request
   * rather than from a constant, so a preview deployment points at itself. The thing that must
   * never happen is a development host reaching production, which is what a hard-coded origin or a
   * value captured at build time would do.
   */
  for (const path of ["/llms.txt", "/docs.md", "/docs/report.md"]) {
    const response = await fetchSite(`https://salidium.com${path}`);
    assert.equal(response.status, 200, `${path} should be served`);
    const body = await response.text();

    /*
     * Hosts of actual URLs, not every occurrence of an address. The documentation says the daemon
     * listens on 127.0.0.1, which is a fact about the product rather than somewhere this site
     * points.
     */
    const hosts = [...new Set([...body.matchAll(/https?:\/\/[^/\s)]+/g)].map((m) => m[0]))];
    assert.deepEqual(hosts, ["https://salidium.com"], `${path} should only name the canonical host`);
  }

  // The index names every page, and each name it gives is a route that exists.
  const llms = await (await fetchSite("https://salidium.com/llms.txt")).text();
  for (const slug of DOC_SLUGS) {
    assert.match(llms, new RegExp(`https://salidium\\.com/docs/${slug}\\.md`), `llms.txt omits ${slug}`);
    const one = await fetchSite(`https://salidium.com/docs/${slug}.md`);
    assert.equal(one.status, 200, `/docs/${slug}.md should be served`);
  }

  // And every page advertises its own text, which is how a fetcher finds it without being told.
  const html = await (await fetchSite("https://salidium.com/docs/report", { accept: "text/html" })).text();
  assert.match(html, /rel="alternate"[^>]*\/docs\/report\.md"[^>]*type="text\/markdown"/);
});

test("redirects www requests to the canonical HTTPS domain", async () => {
  const response = await fetchSite("https://www.salidium.com/docs?source=www");

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://salidium.com/docs?source=www");
});
