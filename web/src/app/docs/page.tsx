import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPage } from "@/lib/docs";
import { DocPageView } from "@/components/docs/DocPageView";

export const metadata: Metadata = { title: "About Tremor" };

/** `/docs` renders the first page (About Tremor → Architecture) as the index. */
export default function DocsIndex() {
  const page = getPage(["about", "architecture"]);
  if (!page) notFound();
  return <DocPageView page={page} />;
}
