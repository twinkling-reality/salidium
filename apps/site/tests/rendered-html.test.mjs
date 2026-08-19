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

test("server-renders the Salidium landing page", async () => {
  const response = await fetchSite("http://localhost/", { accept: "text/html" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Salidium: Agent output, turned into a visual report<\/title>/i);
  assert.match(html, /Agent output, turned into a visual report\./);
  assert.match(html, /what it is doing, why,[\s\S]*how, and what still needs attention/);
  assert.match(html, /npx salidium/);
  assert.match(html, /aria-pressed="false">pnpm</);
  assert.match(html, />Theme \/ Light<\/button>/);
  assert.match(html, /href="\/docs">Docs<\/a>/);
  assert.match(html, /The whole report, not just a summary/);
  assert.match(html, /Approach changed[\s\S]*Verified[\s\S]*Left[\s\S]*Review[\s\S]*Evidence/);
  assert.match(html, /Rewind shows the report at an earlier moment[\s\S]*Quantities shows the scale[\s\S]*History/);
  assert.match(html, /<h2 id="setup-title">Setup<\/h2>/);
  assert.match(html, /Run Salidium once[\s\S]*shows what it wants to connect[\s\S]*asks[\s\S]*first/);
  assert.match(html, /Codex needs one approval in/);
  assert.match(html, /native Windows[\s\S]*transcript history[\s\S]*POSIX live-hook relay/);
  assert.match(
    html,
    /generated explanations send a bounded, redacted excerpt[\s\S]*plan or API allowance[\s\S]*turn them[\s\S]*off/i,
  );
  assert.doesNotMatch(html, /salidium install-hooks|salidium doctor/);
  assert.doesNotMatch(html, /<h2 id="install-title">Install<\/h2>|<span>Start<\/span>/);
  assert.match(html, /data-theme="light"/);
  assert.match(html, /localStorage\.getItem\("salidium-site-theme"\)/);
  assert.match(html, /highlights evidence in a verbose agent response and maps it into Why and How/i);
  assert.match(html, /See the cause and the fix without reading every line/);
  assert.match(html, /I traced the missing session state through SessionCoordinator and transcriptTailer/);
  assert.match(html, /Evidence was lost because the cursor advanced before storage was durable/);
  assert.match(html, /Queue the record\. Flush storage\. Then advance the cursor\./);
  assert.doesNotMatch(html, /translation-arrow|translation-flow|Before · Agent record|After · Salidium/);
  assert.doesNotMatch(html, /og-v3\.png|Checks passed|47 records/);
  assert.doesNotMatch(html, /salidium-demo\.mp4|<video/i);
  assert.doesNotMatch(
    html,
    /The work, without the noise|The short version|What stays local|AuthMiddleware rotates token/,
  );
  assert.doesNotMatch(html, /<select/i);
  assert.doesNotMatch(html, /<details/i);
  assert.doesNotMatch(html, /\u2014/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("server-renders first-party Salidium docs", async () => {
  const response = await fetchSite("http://localhost/docs", { accept: "text/html" });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Salidium Docs<\/title>/i);
  assert.match(html, /aria-label="Salidium home"[\s\S]*brand-divider[\s\S]*brand-section">Docs/);
  assert.match(html, /Start with Salidium/);
  assert.match(html, /Node 24 or newer[\s\S]*npx salidium/);
  assert.match(html, /Read a report[\s\S]*What[\s\S]*Why[\s\S]*How[\s\S]*Verified/);
  assert.match(html, /fact-based report, and interface stay on your machine/);
  assert.match(html, /Generated explanations never decide Verified, Left, or Review/);
  assert.match(html, /Salidium leaves it[\s\S]*unknown/);
  assert.match(html, /SALIDIUM_EXPLAINER=off/);
  assert.match(html, /Windows[\s\S]*transcript history[\s\S]*POSIX live-hook relay/);
  assert.match(html, /salidium doctor[\s\S]*salidium status[\s\S]*salidium restart[\s\S]*salidium stop/);
  assert.doesNotMatch(html, /\u2014/);
});

test("redirects www requests to the canonical HTTPS domain", async () => {
  const response = await fetchSite("https://www.salidium.com/docs?source=www");

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://salidium.com/docs?source=www");
});
