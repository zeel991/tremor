"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "@/components/ui/Icons";
import { NAV, isActive } from "./nav";
import { WalletPill } from "./WalletPill";
import { NetworkChip } from "./NetworkChip";

export function TopBar() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between gap-6 px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Tremor home">
          <LogoMark />
          <span className="text-[18px] font-medium leading-none">Tremor</span>
        </Link>
        <nav className="hidden items-center gap-5 md:flex" aria-label="Primary">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="bracket" aria-current={isActive(pathname, item.href) ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <NetworkChip className="hidden lg:inline-flex" />
          <WalletPill />
        </div>
      </div>
    </header>
  );
}
