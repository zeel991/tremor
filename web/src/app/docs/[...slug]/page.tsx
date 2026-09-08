import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { flatPages, getPage } from "@/lib/docs";
import { DocPageView } from "@/components/docs/DocPageView";

type Props = { params: Promise<{ slug: string[] }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return flatPages().map((p) => ({ slug: [p.group.slug, p.meta.slug] }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getPage(slug);
  return page ? { title: page.meta.title, description: page.meta.description } : { title: "Docs" };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const page = getPage(slug);
  if (!page) notFound();
  return <DocPageView page={page} />;
}
