import type { Metadata } from "next";
import { DigestMessage } from "@/components/digest-message";
import { redeemToken } from "@/lib/digest";

export const metadata: Metadata = { title: "Confirm subscription", robots: { index: false } };

/** The link in the confirmation email lands here; opening it activates the subscription. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const result = typeof token === "string" && token ? await redeemToken("confirm", token) : null;

  if (!result?.ok) {
    return (
      <DigestMessage title="Could not confirm">
        <p>{result?.error ?? "This link is missing its token."} Sign up again from the home page to get a new link.</p>
      </DigestMessage>
    );
  }
  return (
    <DigestMessage title="You're subscribed">
      <p>
        The weekly regulatory digest will go to <strong className="font-medium text-foreground">{result.email}</strong> every
        Monday. Each email has a link to unsubscribe.
      </p>
    </DigestMessage>
  );
}
