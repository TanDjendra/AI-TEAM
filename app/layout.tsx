import type { Metadata } from "next";

import { Sidebar } from "./components/sidebar.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Team Command Center",
  description: "Monitor and control the coder and reviewer agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[var(--surface-sunken)] text-[var(--content)] antialiased">
        <div className="flex h-dvh flex-col lg:flex-row">
          <Sidebar />
          <main className="min-h-0 min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
