"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { BrandMark } from "../../../packages/ui/src/components/Brand";
import { useTheme } from "./theme";

/*
 * The page is three regions on a grey ground: the name and the claim, the ways in, and the product.
 *
 * There is no top bar. With two destinations and a theme switch, a full-width strip above the fold
 * spent a band of the screen on three words; the middle column carries them instead, and each cell
 * is a whole target rather than a line of prose with a link buried in it.
 *
 * The image is a real capture of the real interface, produced by `scripts/capture-demo.mjs`: it
 * boots an actual daemon, ingests a run through the real ingest path, and photographs whatever the
 * reducer derives. Nothing in it is drawn for the site, and re-running the script is what updates
 * the page, so the screenshot cannot drift away from what the product does.
 */

const COMMAND = "npx salidium";

const ALT =
  "The Salidium interface: a session list grouped into Needs you, Working and Recent, and a report for Fix double charges on checkout retry. The verdict reads 4 files changed, unverified, with two files changed after the last passing check, and a diagram shows the checkout request and a retry worker each creating a charge for the same order.";

/** Icons carry these cells, so they are drawn large and stroked light. */
function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      className="cell-ico"
      viewBox="0 0 24 24"
      width="40"
      height="40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/*
 * A filled mark in the corner, the height of a line of text. Set solid in the text colour so it
 * reads as the one thing on the card you are meant to act on, the way a primary control does.
 * It becomes a tick when the copy lands, so the corner and the card agree.
 */
function ArrowMark({ done = false }: { done?: boolean }) {
  return (
    <span className="cell-mark" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {done ? (
          <path d="M5 12.5 10 17.5 19 7" />
        ) : (
          <>
            <path d="M7 17 17 7" />
            <path d="M8.5 7H17v8.5" />
          </>
        )}
      </svg>
    </span>
  );
}

/*
 * Every cell says what it is, and shows what it does the moment a pointer or focus arrives. Both
 * states occupy the same grid cell and are aligned to its bottom, so a one-line reveal lands on
 * the same baseline as the last line of a two-line label rather than floating above it.
 */
function CellBody({ said, shown }: { said: string; shown: ReactNode }) {
  return (
    <span className="cell-swap">
      <span className="cell-swap-said">{said}</span>
      <span className="cell-swap-alt" aria-hidden="true">
        {shown}
      </span>
    </span>
  );
}

type CopyState = "idle" | "copied" | "failed";

function InstallCell() {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    /*
     * writeText rejects on an insecure origin, on a denied permission, in an unfocused tab, and in
     * Safari when the write escapes the user gesture. This used to be an unguarded await, so the
     * rejection skipped the state update and the button did nothing at all, silently, forever.
     */
    try {
      await navigator.clipboard.writeText(COMMAND);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2400);
  }

  return (
    <button
      className="panel cell"
      data-tone="install"
      type="button"
      onClick={copy}
      data-state={state}
      aria-label={`Copy ${COMMAND}`}
    >
      <Ico>
        <path d="M12 3v11M7.5 10.5 12 15l4.5-4.5" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </Ico>
      <ArrowMark done={state === "copied"} />
      {/* The confirmation replaces the command in place, so the whole card answers the click. */}
      <CellBody
        said="Easy, one line install"
        shown={
          state === "copied" ? (
            "Copied to your clipboard"
          ) : state === "failed" ? (
            "Select it and press ⌘C"
          ) : (
            <code>{COMMAND}</code>
          )
        }
      />
      <span className="sr-only" aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed. Select the command and press Command C."
            : ""}
      </span>
    </button>
  );
}

export function Showcase() {
  const { theme, toggle } = useTheme();

  return (
    <section className="card" aria-labelledby="hero-title">
      <div className="panel card-claim">
        <div className="card-brand-row">
          <div className="card-brand">
            <BrandMark size={34} decorative />
            <span>Salidium</span>
          </div>
          {/* The one control on the page, so it is the one thing that is only an icon. */}
          <button
            className="theme-toggle"
            type="button"
            onClick={toggle}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            suppressHydrationWarning
          >
            <svg
              viewBox="0 0 16 16"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>

        <h1 id="hero-title">Agent output, turned into a visual report.</h1>
      </div>

      <div className="card-ways">
        <InstallCell />

        <Link className="panel cell" data-tone="docs" href="/docs">
          <Ico>
            <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 0 4 20.5z" />
            <path d="M4 17.5A1.5 1.5 0 0 1 5.5 16H20" />
          </Ico>
          <ArrowMark />
          <CellBody said="Clear, complete documentation" shown="Open the docs" />
        </Link>

        <a
          className="panel cell"
          data-tone="source"
          href="https://github.com/twinkling-reality/salidium"
        >
          <Ico>
            <path d="M9 19.5c-4.5 1.4-4.5-2.3-6.3-2.7M15 21v-3.4c0-1-.3-1.7-.8-2.1 2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.2-3.3s-1-.3-3.4 1.3a11.9 11.9 0 0 0-6.1 0C6.6 2.4 5.6 2.7 5.6 2.7a4.5 4.5 0 0 0-.2 3.3A4.8 4.8 0 0 0 4.1 9.3c0 4.8 3 5.9 5.8 6.2-.5.4-.8 1.1-.8 2.1V21" />
          </Ico>
          <ArrowMark />
          <CellBody said="Open source, every line" shown="Go to GitHub" />
        </a>
      </div>

      <figure className="panel card-shot">
        <img
          className="shot shot-light"
          src="/report-light.png"
          alt={ALT}
          width={2800}
          height={2862}
        />
        <img
          className="shot shot-dark"
          src="/report-dark.png"
          alt=""
          aria-hidden="true"
          width={2800}
          height={2862}
        />
      </figure>
    </section>
  );
}
