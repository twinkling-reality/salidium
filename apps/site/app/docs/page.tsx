import type { Metadata } from "next";
import { SiteRail } from "../SiteRail";

const title = "Salidium Docs";
const description =
  "Install Salidium, connect Claude Code and Codex, read a report, and understand its privacy boundaries.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/docs" },
  openGraph: { title, description, url: "/docs", images: [] },
  twitter: { card: "summary", title, description, images: [] },
};

export default function DocsPage() {
  return (
    <>
      <SiteRail active="docs" />

      <main className="docs-page">
        <header className="docs-intro">
          <span className="translation-label">Docs</span>
          <h1>Start with Salidium</h1>
          <p>Install it, connect your agents, and see what changed, what passed, and what still needs you.</p>
        </header>

        <section id="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <p>Salidium needs Node 24 or newer. Start it with one command:</p>
          <pre className="docs-command"><code>npx salidium</code></pre>
          <p>
            On first run, Salidium finds Claude Code and Codex, shows the settings it wants to
            update, and asks before making any change. It then opens the local interface. Later
            runs take you straight back.
          </p>
          <p className="docs-note">
            If Salidium adds or updates Codex hooks, approve them once in <code>/hooks</code>.
          </p>
        </section>

        <section id="report" aria-labelledby="read-report-title">
          <h2 id="read-report-title">Read a report</h2>
          <dl className="docs-definitions">
            <div><dt>What</dt><dd>The work the agent is doing and the changes it made.</dd></div>
            <div><dt>Why</dt><dd>Your ask and the discoveries the agent reported, kept clearly attributed.</dd></div>
            <div><dt>How</dt><dd>The plan and approach the agent described.</dd></div>
            <div><dt>Approach changed</dt><dd>The earlier path, its replacement, and the reason for the change.</dd></div>
            <div><dt>Verified</dt><dd>What passed, failed, or stayed unknown, parsed from real check output.</dd></div>
            <div><dt>Left</dt><dd>Work that remains unfinished, failing, or unknown.</dd></div>
            <div><dt>Review</dt><dd>Claims and actions that still need a person.</dd></div>
          </dl>
          <p className="docs-note">
            Evidence opens the files, checks, changes, activity, and original records behind the
            report. Rewind reconstructs an earlier moment. Quantities shows the scale of the work.
            History shows how it unfolded. If the record cannot establish something, Salidium
            leaves it unknown.
          </p>
        </section>

        <section id="privacy" aria-labelledby="privacy-title">
          <h2 id="privacy-title">Privacy</h2>
          <p>
            The daemon, event store, fact-based report, and interface stay on your machine. Salidium
            has no telemetry or hosted reporting service.
          </p>
          <p>
            Optional generated explanations send a bounded, redacted summary through your installed
            Claude or Codex CLI. That CLI may contact its provider and use your plan or API allowance.
            Generated explanations never decide Verified, Left, or Review. Turn them off with{" "}
            <code>SALIDIUM_EXPLAINER=off</code>; the fact-based report still works.
          </p>
        </section>

        <section id="limits" aria-labelledby="limits-title">
          <h2 id="limits-title">Limits and recovery</h2>
          <p>
            On native Windows, transcript history works, but the POSIX live-hook relay is not
            installed. Codex hook approval cannot be confirmed automatically; after Salidium
            changes Codex hooks, review them once in <code>/hooks</code>.
          </p>
          <dl className="docs-commands">
            <div><dt><code>salidium doctor</code></dt><dd>Check local setup and report problems.</dd></div>
            <div><dt><code>salidium status</code></dt><dd>Show the daemon and connection state.</dd></div>
            <div><dt><code>salidium restart</code></dt><dd>Restart Salidium and reopen the interface.</dd></div>
            <div><dt><code>salidium stop</code></dt><dd>Stop the local daemon.</dd></div>
          </dl>
          <p className="docs-note">
            For source, architecture, and contribution details, visit the{" "}
            <a href="https://github.com/twinkling-reality/salidium">GitHub repository</a>.
          </p>
        </section>
      </main>
    </>
  );
}
