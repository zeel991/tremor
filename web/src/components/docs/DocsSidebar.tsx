"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_NAV } from "@/content/docs/nav";

/** Grouped navigation: 12px uppercase group headers, 15px items, active item bold with a lime rule. */
export function DocsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs">
      {DOCS_NAV.map((g) => (
        <div key={g.slug}>
          <div className="docs-group">{g.title}</div>
          <ul className="m-0 list-none p-0">
            {g.pages.map((p) => {
              const href = `/docs/${g.slug}/${p.slug}`;
              const active = pathname === href || (pathname === "/docs" && href === "/docs/about/architecture");
              return (
                <li key={p.slug}>
                  <Link href={href} className="docs-item" aria-current={active ? "page" : undefined} onClick={onNavigate}>
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
