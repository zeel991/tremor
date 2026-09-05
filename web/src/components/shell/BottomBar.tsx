"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isActive } from "./nav";

/** Mobile dock: black bar, square cells, active cell lime. */
export function BottomBar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="dock md:hidden">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className="dock-cell">
            <Icon width={20} height={20} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
