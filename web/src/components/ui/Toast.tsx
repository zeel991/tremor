"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { IconCheck, IconInfo, IconWarning, IconX } from "./Icons";

type Tone = "error" | "success" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}
interface ToastApi {
  error: (title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((p) => p.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Tone, title: string, body?: string) => {
      const id = ++seq.current;
      setItems((p) => [...p.slice(-3), { id, tone, title, body }]);
      setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      error: (t, b) => push("error", t, b),
      success: (t, b) => push("success", t, b),
      info: (t, b) => push("info", t, b),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="fixed bottom-24 right-4 z-50 flex flex-col gap-2 md:bottom-6 md:right-6">
        {items.map((t) => (
          <div key={t.id} role="status" className="toast flex items-start gap-3">
            <span className={t.tone === "error" ? "text-down" : t.tone === "success" ? "text-lime-dark" : "text-ink-2"} style={{ marginTop: 1 }}>
              {t.tone === "error" ? <IconWarning /> : t.tone === "success" ? <IconCheck /> : <IconInfo />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t.title}</div>
              {t.body ? <div className="small mt-0.5 break-words text-ink-2">{t.body}</div> : null}
            </div>
            <button aria-label="Dismiss" className="text-ink-3 hover:text-ink" onClick={() => dismiss(t.id)}>
              <IconX width={16} height={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast outside ToastProvider");
  return api;
}
