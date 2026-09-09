/**
 * Server-side docs loader: reads `src/content/docs/<group>/<page>.md`, fills `{{placeholders}}`
 * from the deployment manifest, extracts headings, computes prev/next and the search index.
 */
import fs from "node:fs";
import path from "node:path";
import { DOCS_NAV, type DocGroup, type DocPageMeta } from "@/content/docs/nav";
import { ADDR, isDeployed } from "@/lib/contracts";
import { activeChain } from "@/config/chains";
import { env } from "@/config/env";

export interface DocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}
export interface DocPage {
  group: DocGroup;
  meta: DocPageMeta;
  href: string;
  /** Markdown body with placeholders resolved. */
  markdown: string;
  headings: DocHeading[];
  prev?: { href: string; title: string; group: string };
  next?: { href: string; title: string; group: string };
}
export interface SearchEntry {
  href: string;
  title: string;
  group: string;
  description: string;
  headings: string[];
  text: string;
}

const ROOT = path.join(process.cwd(), "src", "content", "docs");

export const hrefOf = (group: string, page: string): string => `/docs/${group}/${page}`;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function flatPages(): Array<{ group: DocGroup; meta: DocPageMeta; href: string }> {
  return DOCS_NAV.flatMap((g) => g.pages.map((p) => ({ group: g, meta: p, href: hrefOf(g.slug, p.slug) })));
}

function placeholders(): Record<string, string> {
  const a = ADDR as unknown as Record<string, unknown>;
  const out: Record<string, string> = {
    chainName: activeChain.name,
    chainId: String(activeChain.id),
    deployed: isDeployed ? "deployed" : "not deployed",
    rpcUrl: env.rpcUrl,
    apiUrl: env.apiUrl,
  };
  const keys = [
    "aqua",
    "weth",
    "usdc",
    "feed",
    "router",
    "routerBytecodeHash",
    "routerSourceCommit",
    "seriesFactory",
    "marketEngine",
    "accumulator",
    "seriesDeployer",
    "programs",
    "lens",
    "oracle",
    "writer",
    "buyer",
    "deploymentBlock",
    "schemaVersion",
  ];
  for (const k of keys) {
    const v = a[k];
    out[k] = v === undefined || v === null || v === "" ? "—" : String(v);
  }
  return out;
}

function fill(md: string): string {
  const ph = placeholders();
  return md.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => ph[k] ?? `{{${k}}}`);
}

function readMarkdown(group: string, page: string): string | undefined {
  const file = path.join(ROOT, group, `${page}.md`);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}

/** h2/h3 outside fenced code blocks. */
export function extractHeadings(md: string): DocHeading[] {
  const out: DocHeading[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length === 2 ? 2 : 3, text: m[2].replace(/[`*]/g, ""), id: slugify(m[2]) });
  }
  return out;
}

export function getPage(slug: string[]): DocPage | undefined {
  if (slug.length !== 2) return undefined;
  const [g, p] = slug;
  const group = DOCS_NAV.find((x) => x.slug === g);
  const meta = group?.pages.find((x) => x.slug === p);
  if (!group || !meta) return undefined;
  const raw = readMarkdown(g, p);
  if (raw === undefined) return undefined;
  const markdown = fill(raw);
  const all = flatPages();
  const idx = all.findIndex((x) => x.group.slug === g && x.meta.slug === p);
  const prevP = idx > 0 ? all[idx - 1] : undefined;
  const nextP = idx < all.length - 1 ? all[idx + 1] : undefined;
  return {
    group,
    meta,
    href: hrefOf(g, p),
    markdown,
    headings: extractHeadings(markdown),
    prev: prevP ? { href: prevP.href, title: prevP.meta.title, group: prevP.group.title } : undefined,
    next: nextP ? { href: nextP.href, title: nextP.meta.title, group: nextP.group.title } : undefined,
  };
}

/** Markdown → rough plain text for the search index. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (blk) => blk.replace(/```\w*/g, " "))
    .replace(/\{\{[^}]+\}\}/g, " ")
    .replace(/[#>*_`|]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSearchIndex(): SearchEntry[] {
  return flatPages().map(({ group, meta, href }) => {
    const raw = readMarkdown(group.slug, meta.slug) ?? "";
    const md = fill(raw);
    return {
      href,
      title: meta.title,
      group: group.title,
      description: meta.description,
      headings: extractHeadings(md).map((h) => h.text),
      text: plain(md).slice(0, 6000),
    };
  });
}

/** Markdown for the Copy button: title + description + body. */
export function pageAsMarkdown(page: DocPage): string {
  return `# ${page.meta.title}\n\n${page.meta.description}\n\n${page.markdown.trim()}\n`;
}
