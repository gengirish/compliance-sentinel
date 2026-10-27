import type { Metadata } from "next";
import { DigestMessage } from "@/components/digest-message";
import { UnsubscribeButton } from "@/components/unsubscribe-button";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

/**
 * The digest's unsubscribe link. It asks for a click rather than acting on page load, because
 * mail security scanners open every link in a message and would otherwise unsubscribe readers.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  if (typeof token !== "string" || !token) {
    return (
      <DigestMessage title="Link incomplete">
        <p>This unsubscribe link is missing its token. Use the link at the bottom of any digest email.</p>
      </DigestMessage>
    );
  }
  return (
    <DigestMessage title="Unsubscribe from the weekly digest">
      <UnsubscribeButton token={token} />
    </DigestMessage>
  );
}
