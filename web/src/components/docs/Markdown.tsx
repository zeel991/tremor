import { isValidElement, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugify } from "@/lib/docs";

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const ExternalGlyph = () => (
  <svg className="docs-ext" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v6H4V6h6" />
  </svg>
);

export interface LinkCardItem {
  href: string;
  title: string;
  subtitle?: string;
  icon?: string;
}

/** Icon + title + subtitle + chevron. */
export function LinkCards({ items }: { items: LinkCardItem[] }) {
  return (
    <div className="docs-cards">
      {items.map((it) => {
        const external = /^https?:\/\//.test(it.href);
        const inner = (
          <>
            <span className="docs-card-icon" aria-hidden="true">
              {it.icon ?? "→"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="docs-card-title">{it.title}</span>
              {it.subtitle ? <span className="docs-card-sub">{it.subtitle}</span> : null}
            </span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="docs-card-chev">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </>
        );
        return external ? (
          <a key={it.href} href={it.href} target="_blank" rel="noreferrer" className="docs-card">
            {inner}
          </a>
        ) : (
          <Link key={it.href} href={it.href} className="docs-card">
            {inner}
          </Link>
        );
      })}
    </div>
  );
}

const components: Components = {
  h1: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
  h4: ({ children }) => <h4>{children}</h4>,
  a: ({ href, children }) => {
    const h = href ?? "#";
    if (/^https?:\/\//.test(h)) {
      return (
        <a href={h} target="_blank" rel="noreferrer">
          {children}
          <ExternalGlyph />
        </a>
      );
    }
    return <Link href={h}>{children}</Link>;
  },
  table: ({ children }) => (
    <div className="docs-table-wrap">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const cls = child.props.className ?? "";
      if (cls.includes("language-cards")) {
        try {
          const items = JSON.parse(textOf(child.props.children)) as LinkCardItem[];
          return <LinkCards items={items} />;
        } catch {
          /* fall through to a normal code block */
        }
      }
    }
    return <pre>{children}</pre>;
  },
};

/** GFM markdown → docs prose. Fenced ```cards blocks with a JSON array become link cards. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="docs-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
