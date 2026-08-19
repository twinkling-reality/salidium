"use client";

import { useState } from "react";
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
          <p className="lede">Know what changed, why, what passed, and what needs you.</p>
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
          <DemoTransformation />
        </section>
      </main>
    </>
  );
}
