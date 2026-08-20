import type { Metadata } from "next";
import Link from "next/link";
import { OVERVIEW, PAGES } from "./content";

const description =
  "Install Salidium, read a report, and see exactly what it observed, what it derived, and what a model wrote.";

export const metadata: Metadata = {
  title: "Salidium Docs",
  description,
  alternates: { canonical: "/docs", types: { "text/markdown": "/docs.md" } },
  openGraph: { title: "Salidium Docs", description, url: "/docs", images: [] },
  twitter: { card: "summary", title: "Salidium Docs", description, images: [] },
};

/*
 * The index is every page with the one line that says what it covers. A reader who does not yet
 * know that Salidium calls something "Left" cannot choose it from a list of bare names.
 */
export default function DocsIndex() {
  return (
    <main className="doc-main doc-index" id="main" tabIndex={-1}>
      <header className="doc-lede">
        <h1>{OVERVIEW.title}</h1>
        <p>{OVERVIEW.lede}</p>
      </header>

      <ol className="doc-contents">
        {PAGES.map((page) => (
          <li key={page.slug}>
            <Link href={`/docs/${page.slug}`}>
              <span className="doc-contents-n" aria-hidden="true">
                {page.n}
              </span>
              <span className="doc-contents-title">{page.title}</span>
              <span className="doc-contents-summary">{page.summary}</span>
            </Link>
          </li>
        ))}
      </ol>
    </main>
  );
}
