import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Scout Query",
  description: "A Perplexity-style research chat app with OpenRouter and FastRouter model routing.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <div className="app-glow app-glow-left" />
          <div className="app-glow app-glow-right" />
          {children}
        </div>
      </body>
    </html>
  );
}
