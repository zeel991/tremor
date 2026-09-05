"use client";

import { useEffect, useState } from "react";

const KEY = "tremor-docs-theme";

/** Light/dark toggle for the docs section only. Persists in localStorage; default light. */
export function DocsThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const root = document.getElementById("docs-root");
      setDark(root?.getAttribute("data-docs-theme") === "dark");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    const root = document.getElementById("docs-root");
    if (root) {
      if (next) root.setAttribute("data-docs-theme", "dark");
      else root.removeAttribute("data-docs-theme");
    }
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <button type="button" className="docs-icon-btn" onClick={toggle} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title="Toggle docs theme">
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
