import { ClerkProvider } from "@clerk/nextjs";
import { isE2EBypass } from "@/lib/utils";

export function ClerkProviderWrapper({ children }: { children: React.ReactNode }) {
  if (isE2EBypass()) return children;
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#7C3AED",
          colorBackground: "#111827",
          colorForeground: "#E2E8F0",
          colorInput: "#1E293B",
          colorInputForeground: "#E2E8F0",
          // Clerk derives menu item text, borders and hovers from colorNeutral, which defaults to
          // black: on this dark background "Manage account" and "Sign out" were barely visible.
          colorNeutral: "white",
          colorMuted: "#1E293B",
          colorMutedForeground: "#94A3B8",
          colorBorder: "#1E293B",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
