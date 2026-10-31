import type { Metadata, Viewport } from "next";
// Bundled font files rather than next/font/google, so builds need no network access.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ClerkProviderWrapper } from "@/components/clerk-provider-wrapper";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Compliance Sentinel", template: "%s · Compliance Sentinel" },
  description: "Maps regulations to your codebase, obligation by obligation, with the regulation section and file:line cited. By IntelliForge AI.",
  applicationName: "Compliance Sentinel",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Sentinel", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0A0F1C",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${GeistSans.variable} ${GeistMono.variable} bg-background text-foreground antialiased`}>
        <ClerkProviderWrapper>{children}</ClerkProviderWrapper>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
