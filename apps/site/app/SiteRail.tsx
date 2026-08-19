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

const homeLinks = [
  ["Overview", "/"],
  ["Demo", "/#demo"],
  ["Report", "/#report"],
  ["Setup", "/#setup"],
  ["Docs", "/docs"],
] as const;

const docsLinks = [
  ["Overview", "/docs"],
  ["Install", "/docs#install"],
  ["Read a report", "/docs#report"],
  ["Privacy", "/docs#privacy"],
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
    <aside className={`site-rail site-rail-${active}`}>
      <div className="brand-context">
        <Link className="brand" href="/" aria-label="Salidium home">
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
        {links.map(([label, href], index) => (
          <Link key={href} href={href} aria-current={index === 0 ? "page" : undefined}>
            {label}
          </Link>
        ))}
        <a href="https://github.com/twinkling-reality/salidium">GitHub</a>
      </nav>

      <div className="rail-footer">
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          suppressHydrationWarning
          onClick={toggleTheme}
        >
          {theme === "light" ? "Theme / Light" : "Theme / Dark"}
        </button>
      </div>
    </aside>
  );
}
