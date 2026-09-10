"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchEntry } from "@/lib/docs";

interface Hit {
  entry: SearchEntry;
  score: number;
  snippet?: string;
}

function search(index: SearchEntry[], q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: Hit[] = [];
  for (const entry of index) {
    const title = entry.title.toLowerCase();
    const heads = entry.headings.join(" ").toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    let firstPos = -1;
    for (const t of terms) {
      if (title.includes(t)) score += 10;
      if (heads.includes(t)) score += 5;
      const pos = text.indexOf(t);
      if (pos >= 0) {
        score += 1;
        if (firstPos < 0) firstPos = pos;
      }
    }
    if (score === 0) continue;
    let snippet: string | undefined;
    if (firstPos >= 0) {
      const s = Math.max(0, firstPos - 60);
      snippet = (s > 0 ? "…" : "") + entry.text.slice(s, firstPos + 100) + "…";
    }
    hits.push({ entry, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}

/** Header trigger + ⌘K modal. Arrow keys move, Enter opens. */
export function DocsSearch({ index }: { index: SearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  const hits = useMemo(() => search(index, q), [index, q]);
  const shown: Hit[] = q.trim() ? hits : index.slice(0, 8).map((entry) => ({ entry, score: 0 }));

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setSel(0);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", trap);
    return () => window.removeEventListener("keydown", trap);
  }, [open]);

  const go = (href: string) => {
    close();
    router.push(href);
  };

  return (
    <>
      <button ref={triggerRef} type="button" className="docs-search-trigger" onClick={() => setOpen(true)} aria-label="Search docs">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>Search docs…</span>
        <kbd className="docs-kbd">⌘K</kbd>
      </button>
      {open ? (
        <div className="docs-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()} role="presentation">
          <div className="docs-modal" role="dialog" aria-modal="true" aria-label="Search docs">
            <div className="docs-modal-input">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSel(0);
                }}
                placeholder="Search titles, headings and text…"
                aria-label="Search query"
                role="combobox"
                aria-expanded="true"
                aria-controls="docs-search-results"
                aria-activedescendant={shown[sel] ? `docs-search-option-${sel}` : undefined}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSel((s) => Math.min(shown.length - 1, s + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel((s) => Math.max(0, s - 1));
                  } else if (e.key === "Enter") {
                    const h = shown[sel];
                    if (h) go(h.entry.href);
                  }
                }}
              />
              <kbd className="docs-kbd">esc</kbd>
            </div>
            <ul id="docs-search-results" className="docs-modal-list" role="listbox">
              {shown.length === 0 ? <li className="docs-modal-empty">No results for “{q}”.</li> : null}
              {shown.map((h, i) => (
                <li
                  id={`docs-search-option-${i}`}
                  key={h.entry.href}
                  role="option"
                  aria-selected={i === sel}
                  className="docs-modal-item"
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(h.entry.href);
                  }}
                >
                  <div className="docs-modal-item-title">
                    <span>{h.entry.title}</span>
                    <span className="docs-modal-item-group">{h.entry.group}</span>
                  </div>
                  <div className="docs-modal-item-sub">{h.snippet ?? h.entry.description}</div>
                </li>
              ))}
            </ul>
            <div className="docs-modal-foot">
              <span>↑↓ navigate</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
