import type { Metadata } from "next";
import "./globals.css";

const title = "Salidium: Agent output, turned into a visual report";
const description =
  "A clear report of what Claude Code and Codex changed, why, what passed, and what needs you.";

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
      <body>{children}</body>
    </html>
  );
}
