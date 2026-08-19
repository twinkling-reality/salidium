/** Cloudflare Worker entry point for the Salidium landing page. */
import handler from "vinext/server/app-router-entry";

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

    return handler.fetch(request, env, ctx);
  },
};
