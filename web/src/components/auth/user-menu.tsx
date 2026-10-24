import { UserButton } from "@clerk/nextjs";
import { isE2EBypass } from "@/lib/utils";

export function UserMenu() {
  if (isE2EBypass()) {
    return (
      <span className="grid size-8 place-items-center rounded-full bg-surface-light text-xs text-muted" aria-label="Test user">
        E2E
      </span>
    );
  }
  return <UserButton />;
}
