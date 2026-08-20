import type { Metadata } from "next";
import "./globals.css";

const title = "Salidium: Agent output, turned into a visual report";
const description =
  "Salidium reads a Claude Code or Codex run and tells you what changed, why, which checks passed, and what needs you. Runs on your machine.";

export const metadata: Metadata = {
  metadataBase: new URL("https://salidium.com"),
  title,
  description,
  alternates: { canonical: "/" },
  icons: { icon: "/favicon-v2.svg", shortcut: "/favicon-v2.svg" },
  openGraph: { type: "website", url: "/", title, description },
  twitter: { card: "summary", title, description },
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
        {/* Five rail controls precede the content on every page; this is the way past them. */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
