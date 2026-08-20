import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Blocks } from "../Blocks";
import { findPage, PAGES } from "../content";

export function generateStaticParams() {
  return PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) return { title: "Salidium Docs" };
  const title = `${page.title}: Salidium Docs`;
  return {
    title,
    description: page.summary,
    alternates: {
      canonical: `/docs/${page.slug}`,
      types: { "text/markdown": `/docs/${page.slug}.md` },
    },
    openGraph: { title, description: page.summary, url: `/docs/${page.slug}`, images: [] },
    twitter: { card: "summary", title, description: page.summary, images: [] },
  };
}

/** The next page in reading order, so a reader who finishes one is not returned to a list. */
function nextPage(slug: string) {
  const i = PAGES.findIndex((page) => page.slug === slug);
  return i >= 0 ? PAGES[i + 1] : undefined;
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) notFound();

  const next = nextPage(slug);

  return (
    <main className="doc-main" id="main" tabIndex={-1}>
      <article>
        <header className="doc-lede">
          <h1>{page.title}</h1>
          <p>{page.summary}</p>
        </header>

        <Blocks blocks={page.blocks} />
      </article>

      {next && (
        <nav className="doc-next" aria-label="Continue reading">
          <a href={`/docs/${next.slug}`}>
            <span className="doc-next-label">Next page</span>
            <span className="doc-next-title">{next.title}</span>
          </a>
        </nav>
      )}
    </main>
  );
}
