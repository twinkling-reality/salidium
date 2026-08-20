/** Cloudflare Worker entry point for the Salidium landing page. */
import handler from "vinext/server/app-router-entry";
import { docsMarkdown, findPage, llmsTxt } from "../app/docs/content";

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
