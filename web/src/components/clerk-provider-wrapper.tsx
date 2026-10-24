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
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
