import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anime API — Jikan + Official MAL v2",
  description: "Jikan (MyAnimeList) primary with official MAL API v2 fallback. Miruro for streaming servers. No AniList.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
