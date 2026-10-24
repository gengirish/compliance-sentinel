import type { Metadata } from "next";
// Bundled font files rather than next/font/google, so builds need no network access.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ClerkProviderWrapper } from "@/components/clerk-provider-wrapper";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Compliance Sentinel", template: "%s · Compliance Sentinel" },
  description: "Regulatory change monitoring and codebase compliance audits, by IntelliForge AI.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${GeistSans.variable} ${GeistMono.variable} bg-background text-foreground antialiased`}>
        <ClerkProviderWrapper>{children}</ClerkProviderWrapper>
      </body>
    </html>
  );
}
