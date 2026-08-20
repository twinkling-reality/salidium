import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "../../../packages/ui/src/components/Brand";

export const metadata: Metadata = {
  title: "Page not found: Salidium",
  description: "There is no page at this address.",
};

/*
 * The 404, which was the framework's own: an unstyled "This page could not be found." carrying the
 * home page's title, in a system font, with no mark, no palette and no way on. Every mistyped
 * `/docs/...` address landed there, which is most of the ways a person arrives at one.
 *
 * It is the lockup, one sentence, and the two places worth going. Deliberately not a search box, a
 * suggestion list, or an illustration: nothing here knows what was meant, and a page that guesses
 * would be inventing an answer on a site whose whole subject is not doing that.
 */
export default function NotFound() {
  return (
    <main id="main" className="notfound" tabIndex={-1}>
      <div className="notfound-inner">
        {/* The mark is the way home, which is where a mark goes. */}
        <Link className="card-brand notfound-brand" href="/">
          <BrandMark size={34} decorative />
          <span>Salidium</span>
        </Link>
        <h1 className="notfound-line">There is no page at this address.</h1>
        <Link className="notfound-back" href="/docs">
          Documentation
        </Link>
      </div>
    </main>
  );
}
