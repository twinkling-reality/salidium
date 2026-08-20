import type { Metadata } from "next";
import { SiteRail } from "../SiteRail";

const title = "Salidium Docs";
const description =
  "Install Salidium, connect Claude Code and Codex, read a report, and see what stays on your machine.";

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

      <main className="docs-page" id="main">
        <header className="docs-intro">
          <h1>Set up Salidium</h1>
          <p>Two minutes to a first report.</p>
        </header>

        <section id="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <p>Salidium needs Node 24 or newer.</p>
          <pre className="docs-command">
            <code>npx salidium</code>
          </pre>
          <p>
            With pnpm, run <code>pnpm dlx salidium</code> instead.
          </p>
          <p>
            On first run, Salidium looks for Claude Code and Codex, shows you the exact settings
            files it wants to change, and asks once before touching them. Then it opens the
            interface. Run the same command later and it reopens whatever is already running.
          </p>
          <p className="docs-note">
            If Salidium adds or updates Codex hooks, approve them once in <code>/hooks</code>.
          </p>
        </section>

        <section id="report" aria-labelledby="read-report-title">
          <h2 id="read-report-title">Read a report</h2>

          <h3>Derived from the record</h3>
          <p>
            Salidium works these out from the run itself. A generated explanation cannot change
            them.
          </p>
          <dl className="docs-definitions">
            <div>
              <dt>Changed</dt>
              <dd>Every file the agent&rsquo;s tools touched, with the diff and the record behind it.</dd>
            </div>
            <div>
              <dt>Verified</dt>
              <dd>
                Which test, build, typecheck, and lint runs actually happened, and what their output
                said: passed, failed, ran on a subset, or unreadable. A command name is not proof.
              </dd>
            </div>
            <div>
              <dt>Left</dt>
              <dd>Work the agent recorded as unfinished, in progress, or failing.</dd>
            </div>
            <div>
              <dt>Needs you</dt>
              <dd>
                A failing check, a prompt waiting on you, a destructive command, files changed after
                the last passing run, or a claim that checks passed when none did.
              </dd>
            </div>
          </dl>

          <h3>Generated, and labelled as such</h3>
          <p>
            These are written by your own Claude or Codex CLI from the evidence above, and are
            marked as generated wherever they appear.
          </p>
          <dl className="docs-definitions">
            <div>
              <dt>What</dt>
              <dd>One sentence on what the session was about.</dd>
            </div>
            <div>
              <dt>Why</dt>
              <dd>
                The cause, drawn as a chain, or as separate paths converging when there was more than
                one.
              </dd>
            </div>
            <div>
              <dt>How</dt>
              <dd>The component the change centred on, with its parts beneath it.</dd>
            </div>
            <div>
              <dt>Approach changed</dt>
              <dd>The path that was abandoned above the one that replaced it, and the reason.</dd>
            </div>
          </dl>
          <p>
            Turn generated explanations off and Changed, Verified, Left, Needs you, and all the
            evidence stay exactly as they are.
          </p>
        </section>

        <section id="deeper" aria-labelledby="deeper-title">
          <h2 id="deeper-title">Go deeper</h2>
          <dl className="docs-definitions">
            <div>
              <dt>Evidence</dt>
              <dd>
                Which changed files a passing check actually ran after, the checks over time, what
                changed, and what happened in order.
              </dd>
            </div>
            <div>
              <dt>Rewind</dt>
              <dd>
                Drag the scrubber and the page becomes the session as it stood at that moment.
                Anything later is hidden.
              </dd>
            </div>
            <div>
              <dt>History</dt>
              <dd>Every change with a How we know column, and a link to the original line.</dd>
            </div>
            <div>
              <dt>Quantities</dt>
              <dd>Files, lines, turns, commits, duration.</dd>
            </div>
          </dl>
          <p>
            Every statement carries how it is known: observed, reported by the agent, derived by
            Salidium, or generated. If the record cannot establish something, Salidium says unknown
            rather than guessing.
          </p>
        </section>

        <section id="local" aria-labelledby="local-title">
          <h2 id="local-title">What stays on your machine</h2>
          <p>
            The daemon, the event store, the report, and the interface never leave your machine.
            Salidium has no account, no telemetry, and no hosted service. State lives in{" "}
            <code>~/.salidium</code>, and the daemon listens only on <code>127.0.0.1</code> behind a
            token.
          </p>
          <p>
            Generated explanations are the one exception, and they are optional. Once per finished
            turn, Salidium hands your installed Claude or Codex CLI a bounded, redacted summary. That
            CLI talks to its own provider and spends your existing plan or API allowance. It runs
            with tools disabled and cannot change Changed, Verified, Left, or Needs you. Set{" "}
            <code>SALIDIUM_EXPLAINER=off</code> and nothing is sent.
          </p>
        </section>

        <section id="limits" aria-labelledby="limits-title">
          <h2 id="limits-title">Limits and recovery</h2>
          <p>
            On Windows, Salidium reads the session files your agents already write, so history works,
            but live updates during a run do not. Codex hook approval cannot be confirmed
            automatically: after Salidium changes Codex hooks, review them once in{" "}
            <code>/hooks</code>.
          </p>
          <dl className="docs-commands">
            <div>
              <dt>
                <code>salidium doctor</code>
              </dt>
              <dd>Check local setup and report problems.</dd>
            </div>
            <div>
              <dt>
                <code>salidium status</code>
              </dt>
              <dd>Show the daemon and connection state.</dd>
            </div>
            <div>
              <dt>
                <code>salidium restart</code>
              </dt>
              <dd>Restart Salidium and reopen the interface.</dd>
            </div>
            <div>
              <dt>
                <code>salidium stop</code>
              </dt>
              <dd>Stop the local daemon.</dd>
            </div>
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
