"use client";

import { useEffect, useState, type RefObject } from "react";

/** True while the element is in the viewport and the tab is visible. */
export function useInViewActive(ref: RefObject<HTMLElement | null>, rootMargin = "0px"): boolean {
  const [inView, setInView] = useState(false);
  const visible = useTabVisible();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { rootMargin, threshold: 0.05 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, rootMargin]);
  return inView && visible;
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
}

/** Reduced-motion preference freezes the wave on a single static frame. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
