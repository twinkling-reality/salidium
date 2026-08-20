"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { BrandMark } from "../../../packages/ui/src/components/Brand";

type Theme = "light" | "dark";

const themeEvent = "salidium-site-theme-change";
let visitTheme: Theme | null = null;

function readTheme(): Theme {
  if (visitTheme) return visitTheme;
  try {
    return window.localStorage.getItem("salidium-site-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function subscribeToTheme(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(themeEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(themeEvent, onStoreChange);
  };
}

/*
 * No link points at the page it sits on. Both lists used to open with "Overview", which on the
 * page itself was a link back to where you already were.
 */
const homeLinks = [["Docs", "/docs"]] as const;

const docsLinks = [
  ["Install", "/docs#install"],
  ["Read a report", "/docs#report"],
  ["What stays local", "/docs#local"],
  ["Limits", "/docs#limits"],
] as const;

export function SiteRail({ active }: { active: "home" | "docs" }) {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    visitTheme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem("salidium-site-theme", nextTheme);
    } catch {
      // Keep the in-page choice working when storage is unavailable.
    }
    window.dispatchEvent(new Event(themeEvent));
  }

  const links = active === "docs" ? docsLinks : homeLinks;

  return (
    /*
     * A bar across the top rather than a column down the side. The rail held three links and a
     * theme switch in a 216px column running the full height of the page, which spent a sixth of
     * every screen on furniture and pushed the content off centre.
     */
    <header className={`site-head site-head-${active}`}>
      <div className="brand-context">
        <Link
          className="brand"
          href="/"
          aria-label="Salidium home"
          aria-current={active === "home" ? "page" : undefined}
        >
          <BrandMark size={18} decorative />
          <span>Salidium</span>
        </Link>
        {active === "docs" && (
          <>
            <span className="brand-divider" aria-hidden="true">/</span>
            <span className="brand-section">Docs</span>
          </>
        )}
      </div>

      <nav aria-label={active === "docs" ? "Documentation" : "Primary navigation"}>
        {links.map(([label, href]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
        <a href="https://github.com/twinkling-reality/salidium">GitHub</a>

        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          suppressHydrationWarning
          onClick={toggleTheme}
        >
          {theme === "light" ? "Light" : "Dark"}
        </button>
      </nav>
    </header>
  );
}
