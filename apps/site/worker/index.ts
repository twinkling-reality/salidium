/** Cloudflare Worker entry point for the Salidium landing page. */
import handler from "vinext/server/app-router-entry";
import { docsMarkdown, findPage, llmsTxt, PAGES } from "../app/docs/content";

const CANONICAL_HOST = "salidium.com";
const REDIRECT_HOST = `www.${CANONICAL_HOST}`;

export default {
  async fetch(
    request: Request,
    env?: Parameters<typeof handler.fetch>[1],
    ctx?: Parameters<typeof handler.fetch>[2],
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === REDIRECT_HOST) {
      url.protocol = "https:";
      url.hostname = CANONICAL_HOST;
      url.port = "";
      return Response.redirect(url, 308);
    }

    /*
     * The documentation as plain Markdown, rendered from the same tree the page renders, so a
     * fetcher is handed the text instead of having to strip tags out of a rendered document.
     */
    /*
     * The map an agent is pointed at first. `/llms.txt` is the convention, and it is served from
     * the same tree the pages render, so it cannot list a page that is not there.
     */
    if (url.pathname === "/llms.txt") {
      return new Response(llmsTxt(url.origin), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    /*
     * What a crawler is handed. It used to be the platform's own content-signals boilerplate:
     * twenty-five lines explaining what a content signal is, followed by no signal, no user-agent
     * and no directive. It named neither the sitemap nor `/llms.txt`, so the two files that exist
     * to be found were findable only by guessing at them.
     */
    if (url.pathname === "/robots.txt") {
      return new Response(
        [
          "User-agent: *",
          "Allow: /",
          "",
          `Sitemap: ${url.origin}/sitemap.xml`,
          "",
          "# The documentation as plain text, and as one file per page:",
          `# ${url.origin}/llms.txt`,
          `# ${url.origin}/docs.md`,
          "",
        ].join("\n"),
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    /*
     * Sixteen addresses, generated from the same tree the pages render, so it cannot list a page
     * that is not there or miss one that is. No `lastmod`: nothing here records when a page last
     * changed, and a date this file invented would be the one untrue thing on the site.
     */
    if (url.pathname === "/sitemap.xml") {
      const paths = ["/", "/docs", ...PAGES.map((page) => `/docs/${page.slug}`)];
      return new Response(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...paths.map((path) => `  <url><loc>${url.origin}${path}</loc></url>`),
          "</urlset>",
          "",
        ].join("\n"),
        {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    /*
     * The classic path, which anything that does not read `<link rel="icon">` asks for directly and
     * was answered with the 404 page. A redirect rather than a second file: one mark, in one
     * format, so the two cannot come to disagree.
     */
    if (url.pathname === "/favicon.ico") {
      return Response.redirect(`${url.origin}/favicon-v2.svg`, 301);
    }

    const markdown = /^\/docs(?:\/([a-z0-9-]+))?\.md$/.exec(url.pathname);
    if (markdown) {
      /*
       * A slug that is not a page is not a page in this format either. Serving it 200 with an empty
       * body told a fetcher the page existed and had nothing in it.
       */
      if (markdown[1] && !findPage(markdown[1])) {
        return new Response("Not found\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(docsMarkdown(url.origin, markdown[1]), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    return handler.fetch(request, env, ctx);
  },
};
