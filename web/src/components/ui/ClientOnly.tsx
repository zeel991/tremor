"use client";

import { useMounted } from "@/lib/hooks";

export function ClientOnly({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const mounted = useMounted();
  return <>{mounted ? children : fallback}</>;
}
