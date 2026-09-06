import type { ComponentType, SVGProps } from "react";
import { IconDocs, IconHedge, IconMarkets, IconPortfolio, IconSwap, IconWrite } from "@/components/ui/Icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Top-nav / dock links. Home is the logo mark. */
export const NAV: NavItem[] = [
  { href: "/markets", label: "Markets", icon: IconMarkets },
  { href: "/pairs", label: "Paired", icon: IconSwap },
  { href: "/write", label: "Write", icon: IconWrite },
  { href: "/portfolio", label: "Portfolio", icon: IconPortfolio },
  { href: "/hedge", label: "Hedge", icon: IconHedge },
  { href: "/docs", label: "Docs", icon: IconDocs },
];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/markets") return pathname.startsWith("/markets") || pathname.startsWith("/series");
  return pathname.startsWith(href);
}

export function titleFor(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname.startsWith("/series/")) return "Series";
  if (pathname.startsWith("/pairs/")) return "Paired market";
  if (pathname.startsWith("/pairs")) return "Paired markets";
  const item = NAV.find((n) => pathname.startsWith(n.href));
  return item?.label ?? "Tremor";
}
