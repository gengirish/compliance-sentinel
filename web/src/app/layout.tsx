import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProviderWrapper } from "@/components/clerk-provider-wrapper";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Compliance Sentinel", template: "%s · Compliance Sentinel" },
  description: "Regulatory change monitoring and codebase compliance audits, by IntelliForge AI.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} bg-background text-foreground antialiased`}>
        <ClerkProviderWrapper>{children}</ClerkProviderWrapper>
      </body>
    </html>
  );
}
