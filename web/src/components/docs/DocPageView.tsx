import Link from "next/link";
import type { DocPage } from "@/lib/docs";
import { pageAsMarkdown } from "@/lib/docs";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { OnThisPage } from "./OnThisPage";

export function DocPageView({ page }: { page: DocPage }) {
  return (
    <div className="docs-page">
      <article className="docs-content">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="docs-crumb">{page.group.title}</div>
            <h1 className="docs-h1">{page.meta.title}</h1>
          </div>
          <CopyButton markdown={pageAsMarkdown(page)} />
        </div>
        <p className="docs-lede">{page.meta.description}</p>
        <Markdown source={page.markdown} />
        <nav className="docs-pn" aria-label="Pagination">
          {page.prev ? (
            <Link href={page.prev.href} className="docs-pn-prev">
              <span className="docs-pn-label">← Previous</span>
              <span className="docs-pn-title">{page.prev.title}</span>
              <span className="docs-pn-group">{page.prev.group}</span>
            </Link>
          ) : (
            <span />
          )}
          {page.next ? (
            <Link href={page.next.href} className="docs-pn-next">
              <span className="docs-pn-label">Next →</span>
              <span className="docs-pn-title">{page.next.title}</span>
              <span className="docs-pn-group">{page.next.group}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
      <aside className="docs-toc-rail hidden xl:block">
        <OnThisPage headings={page.headings} />
      </aside>
    </div>
  );
}
