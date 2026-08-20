"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { DocsShell } from "./DocsChrome";
import { docsMarkdown, findPage } from "./content";

/*
 * The head and the navigation are the same on every documentation page, so they live here rather
 * than in each one. What the head offers depends on where you are: one page offers its own text,
 * the index offers all of it.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const slug = path.startsWith("/docs/") ? path.slice("/docs/".length) : undefined;
  const page = slug ? findPage(slug) : undefined;

  return (
    <DocsShell
      markdown={docsMarkdown(undefined, page?.slug)}
      mdPath={page ? `/docs/${page.slug}.md` : "/docs.md"}
    >
      {children}
    </DocsShell>
  );
}
