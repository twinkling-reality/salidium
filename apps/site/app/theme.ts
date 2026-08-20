"use client";

import { useEffect, useSyncExternalStore } from "react";

/*
 * The site's theme choice, in one place so the home page and the docs rail read the same store
 * rather than each keeping their own copy of it.
 */

export type Theme = "light" | "dark";

const themeEvent = "salidium-site-theme-change";

/* Held in a module variable as well as storage, so a visit still works when storage throws. */
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

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "light" as const);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    visitTheme = next;
    /*
     * Every colour on the page changes at once, and the transitions written for a control
     * answering a pointer are not for that: they turned one repaint into a two hundred millisecond
     * disagreement, with black cards carrying pale grey marks in the middle of it. The flag holds
     * them off for the frame the swap lands in, then lets go.
     */
    const root = document.documentElement;
    root.dataset.theming = "";
    root.dataset.theme = next;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        delete root.dataset.theming;
      });
    });
    try {
      window.localStorage.setItem("salidium-site-theme", next);
    } catch {
      // Keep the in-page choice working when storage is unavailable.
    }
    window.dispatchEvent(new Event(themeEvent));
  }

  return { theme, toggle };
}
