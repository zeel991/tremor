import Link from "next/link";
import { LogoMark } from "@/components/ui/Icons";
import { NAV } from "./nav";

export function Footer() {
  return (
    <footer className="hidden border-t border-line md:block">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-6 py-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2.5">
          <LogoMark size={12} />
          <span className="text-[13px] font-medium">Tremor</span>
          <span className="label">Built on 1inch Aqua · Base</span>
        </div>
        <nav className="flex flex-wrap items-center gap-4" aria-label="Footer">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="bracket bracket-muted">
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
