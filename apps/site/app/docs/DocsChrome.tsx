"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "../../../../packages/ui/src/components/Brand";
import { useCopy } from "../copy";
import { useTheme } from "../theme";
import { PAGES } from "./content";

/* The parts of the documentation that answer something. Everything else is text. */

function Mark({ done }: { done: boolean }) {
  return (
    <span className="doc-mark" data-done={done ? "" : undefined} aria-hidden="true">
      <svg
        className="doc-mark-glyph doc-mark-go"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
      </svg>
      <svg
        className="doc-mark-glyph doc-mark-done"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12.5 10 17.5 19 7" />
      </svg>
    </span>
  );
}

/*
 * Handing the page to something that would rather read text.
 *
 * Two audiences, one control, which is how the references do it: the button copies, and the menu
 * beside it offers the other ways out. `docs.exa.ai` puts a split button under its title and
 * advertises `llms.txt` and a `text/markdown` alternate for every page; this does the same, and
 * every route it names is served by the worker rather than assembled here.
 *
 * Not a `<details>` and not a `<select>`: both are on this site's rejected list, and a menu is a
 * button that says whether it is open and a list that says it is a menu.
 */
function AgentMenu({ markdown, mdPath }: { markdown: string; mdPath: string }) {
  const { state, answered, copy } = useCopy(markdown);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      /* Back to what opened it. Closing alone left focus on an element that no longer existed,
       * which the browser resolves by putting it on the body and losing the reader's place. */
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  /*
   * Absolute, because the destination is another site and a relative path would arrive there
   * meaning nothing. Read at the click rather than baked in, so a preview build points at itself.
   */
  const ask = (base: string) => () => {
    const url = `${window.location.origin}${mdPath}`;
    window.open(
      `${base}${encodeURIComponent(`Read ${url} and answer questions about Salidium using it.`)}`,
      "_blank",
      "noopener,noreferrer",
    );
    setOpen(false);
  };

  return (
    <div className="doc-agent" ref={wrap}>
      <button className="doc-agent-copy" type="button" onClick={copy} data-state={state === "idle" ? undefined : state}>
        <span className="doc-swap">
          <span className="doc-swap-said">Copy page</span>
          <span className="doc-swap-ack" aria-hidden="true">
            {answered === "copied" ? "Copied" : "Press ⌘C"}
          </span>
        </span>
        <Mark done={state === "copied"} />
      </button>

      <button
        className="doc-agent-more"
        type="button"
        ref={trigger}
        aria-expanded={open}
        aria-controls="doc-agent-menu"
        aria-label="Other ways to take this page"
        onClick={() => setOpen((was: boolean) => !was)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {/*
       * A disclosure holding four links, not a menu. `role="menu"` promises arrow-key navigation
       * and a roving tabindex, and announcing a widget that does not behave like one leaves a
       * screen reader user pressing keys that do nothing.
       */}
      <div className={`doc-agent-menu arrives ${open ? "is-open" : ""}`} id="doc-agent-menu">
          <a href={mdPath} onClick={() => setOpen(false)}>
            View as Markdown
          </a>
          <a href="/llms.txt" onClick={() => setOpen(false)}>
            All the docs, as llms.txt
          </a>
          <button type="button" onClick={ask("https://claude.ai/new?q=")}>
            Open in Claude
          </button>
          <button type="button" onClick={ask("https://chatgpt.com/?q=")}>
            Open in ChatGPT
          </button>
      </div>

      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Page copied as Markdown" : state === "failed" ? "Copy failed." : ""}
      </span>
    </div>
  );
}

/* The command line is the control: a bordered box with "Copy" written in it put a second thing on
 * a line that already said what it was, and the label was the widest part of it. */
export function CopyCommand({ command }: { command: string }) {
  const { state, copy } = useCopy(command);

  return (
    <>
      <button
        className="doc-command"
        type="button"
        onClick={copy}
        data-state={state === "idle" ? undefined : state}
        aria-label={`Copy ${command}`}
      >
        <code>{command}</code>
        <Mark done={state === "copied"} />
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed. Select the command and press Command C."
            : ""}
      </span>
    </>
  );
}

/*
 * The whole documentation, grouped by what the pages are about. Marking the current page comes
 * from the path rather than from watching the viewport: which page you are on is a fact the router
 * already has, where which heading you are near was a guess that had to be observed and could
 * disagree with the address bar.
 */
function DocsNav() {
  const path = usePathname();

  return (
    <nav className="doc-nav" aria-label="Documentation">
      <ol>
        {PAGES.map((page) => {
          const href = `/docs/${page.slug}`;
          return (
            <li key={page.slug}>
              <Link
                href={href}
                aria-current={path === href ? "page" : undefined}
                suppressHydrationWarning
              >
                <span className="doc-nav-n" aria-hidden="true">
                  {page.n}
                </span>
                {page.title}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function DocsShell({
  markdown,
  mdPath,
  children,
}: {
  markdown: string;
  mdPath: string;
  children: ReactNode;
}) {
  const { theme, toggle } = useTheme();

  return (
    <div className="doc-page">
      <header className="doc-head">
        <Link className="doc-brand" href="/" aria-label="Salidium home">
          <BrandMark size={20} decorative />
          <span>Salidium</span>
        </Link>
        <span className="doc-brand-divider" aria-hidden="true">
          /
        </span>
        <Link className="doc-brand-section" href="/docs">
          Docs
        </Link>

        <div className="doc-head-actions">
          <AgentMenu markdown={markdown} mdPath={mdPath} />
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
      </header>

      <div className="doc-frame">
        <DocsNav />
        {children}
      </div>
    </div>
  );
}
