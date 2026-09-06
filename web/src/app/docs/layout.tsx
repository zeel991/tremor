import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/components/ui/Icons";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { DocsThemeToggle } from "@/components/docs/DocsThemeToggle";
import { buildSearchIndex } from "@/lib/docs";

export const metadata: Metadata = { title: { default: "Docs", template: "%s · Tremor Docs" } };

const THEME_BOOT = `try{if(localStorage.getItem('tremor-docs-theme')==='dark'){document.currentScript.parentElement.setAttribute('data-docs-theme','dark')}}catch(e){}`;

/** GitBook-style docs shell: header with centered search, 280px grouped sidebar, content column. */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const index = buildSearchIndex();
  return (
    <div id="docs-root" className="docs" suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      <a className="skip-link" href="#docs-main-content">Skip to documentation</a>
      <header className="docs-header">
        <Link href="/docs" className="flex items-center gap-2.5" aria-label="Tremor docs home">
          <LogoMark />
          <span className="text-[16px] font-semibold leading-none">Tremor</span>
          <span className="docs-crumb leading-none">Docs</span>
        </Link>
        <DocsSearch index={index} />
        <div className="flex items-center gap-2">
          <DocsThemeToggle />
          <Link href="/" className="docs-btn">
            Open app
          </Link>
        </div>
      </header>
      <div className="docs-grid">
        <aside className="docs-side">
          <DocsSidebar />
          <div className="docs-side-foot">
            <span className="sq" />
            Built on 1inch Aqua
          </div>
        </aside>
        <main id="docs-main-content" tabIndex={-1} className="docs-main">
          <details className="docs-menu">
            <summary>Docs menu</summary>
            <div className="docs-menu-body">
              <DocsSidebar />
            </div>
          </details>
          {children}
        </main>
      </div>
    </div>
  );
}
