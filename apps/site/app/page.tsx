"use client";

import { useState } from "react";
import Link from "next/link";
import { DemoTransformation } from "./DemoTransformation";
import { SiteRail } from "./SiteRail";

type Runner = "npx" | "pnpm";

const installCommands: Record<Runner, string> = {
  npx: "npx salidium",
  pnpm: "pnpm dlx salidium",
};

type CommandButtonProps = {
  copied: boolean;
  onCopy: (value: string) => void;
  value: string;
};

function CommandButton({ copied, onCopy, value }: CommandButtonProps) {
  return (
    <button
      className="command"
      type="button"
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
      onClick={() => onCopy(value)}
    >
      <span className="command-prompt" aria-hidden="true">$</span>
      <code>{value}</code>
      <span className="command-action" aria-hidden="true">
        {copied ? <span className="copy-check">✓</span> : <span className="copy-icon" />}
      </span>
      <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}

export default function Home() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [runner, setRunner] = useState<Runner>("npx");
  const command = installCommands[runner];

  async function copyCommand(value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedCommand(value);
    window.setTimeout(() => setCopiedCommand(null), 1600);
  }

  return (
    <>
      <SiteRail active="home" />

      <main>
        <section className="hero" id="overview" aria-labelledby="hero-title">
          <h1 id="hero-title">Agent output, turned into a visual report.</h1>
          <p className="lede">
            Salidium turns verbose activity into a visual explanation of what it is doing, why,
            how, and what still needs attention.
          </p>
          <div className="install-command">
            <div className="runner-tabs" aria-label="Package runner">
              {(Object.keys(installCommands) as Runner[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={runner === option}
                  onClick={() => {
                    setRunner(option);
                    setCopiedCommand(null);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
            <CommandButton
              value={command}
              copied={copiedCommand === command}
              onCopy={copyCommand}
            />
          </div>
        </section>

        <section className="demo" id="demo" aria-labelledby="demo-title">
          <h2 className="sr-only" id="demo-title">Salidium product demo</h2>
          <DemoTransformation />
        </section>

        <section className="report-overview" id="report" aria-labelledby="report-title">
          <h2 id="report-title">The whole report, not just a summary</h2>
          <p>
            The visual explanation gives you Why and How. The rest stays organized, checkable, and
            linked to the agent record.
          </p>
          <dl className="report-map">
            <div>
              <dt>What</dt>
              <dd>The work in progress and the changes the agent made.</dd>
            </div>
            <div>
              <dt>Approach changed</dt>
              <dd>What the agent tried before, what replaced it, and why.</dd>
            </div>
            <div>
              <dt>Verified</dt>
              <dd>What passed, failed, or stayed unknown in real check output.</dd>
            </div>
            <div>
              <dt>Left</dt>
              <dd>What is unfinished, failing, or still unknown.</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>What deserves a human look before you trust the work.</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>The files, checks, changes, and original records behind each fact.</dd>
            </div>
          </dl>
          <p className="report-tools">
            Rewind shows the report at an earlier moment. Quantities shows the scale of the work.
            History shows how it unfolded. <Link href="/docs#report">Read the report guide.</Link>
          </p>
        </section>

        <section className="setup" id="setup" aria-labelledby="setup-title">
          <h2 id="setup-title">Setup</h2>
          <p>
            Run Salidium once. It finds Claude Code and Codex, shows what it wants to connect, asks
            first, then opens the local interface. Later, <code>npx salidium</code> takes you straight
            back.
          </p>
          <p className="setup-note">
            Codex needs one approval in <code>/hooks</code>. On native Windows, transcript history
            works, but the POSIX live-hook relay is not installed. Optional generated explanations
            send a bounded, redacted excerpt through your installed CLI, which may use your plan or
            API allowance. You can turn them off.
          </p>
        </section>
      </main>
    </>
  );
}
