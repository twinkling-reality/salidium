import type { Metadata } from "next";
import "./globals.css";

const title = "Salidium: Agent output, turned into a visual report";
const description =
  "Salidium reads a Claude Code or Codex run and tells you what changed, why, which checks passed, and what it flagged for a human. Runs on your machine.";

/*
 * The link card. It is a capture of the running interface at 1200x630, written by
 * `scripts/capture-demo.mjs` from the same seeded daemon every other image on this site comes
 * from, so it cannot show a product that does not exist. Shared anywhere, this page used to render
 * as a bare text card: the one thing worth showing about a visual report was the thing a link
 * to it did not carry.
 */
const card = {
  url: "/card.png",
  width: 2400,
  height: 1260,
  alt: "A Salidium report for Fix double charges on checkout retry. The verdict reads 4 files changed, unverified, with two files changed after the last passing check, and two things to review.",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://salidium.com"),
  title,
  description,
  alternates: {
    canonical: "/",
    /*
     * The documentation as plain text, said in the head rather than left to a convention an agent
     * has to already know. `/llms.txt` was reachable and advertised from nowhere at all.
     */
    types: { "text/plain": "/llms.txt" },
  },
  icons: { icon: "/favicon-v2.svg", shortcut: "/favicon-v2.svg" },
  openGraph: { type: "website", url: "/", title, description, images: [card] },
  twitter: { card: "summary_large_image", title, description, images: [card] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("salidium-site-theme")==="dark")document.documentElement.dataset.theme="dark"}catch{}',
          }}
        />
      </head>
      <body>
        {/*
         * The way past the controls that precede the content on every page. `tabindex="-1"` on the
         * target is what makes it move focus as well as the viewport: without it the browser
         * scrolls and leaves focus where it was, so the next Tab goes back into what was skipped.
         */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
