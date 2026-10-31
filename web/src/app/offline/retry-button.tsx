"use client";

import { Button } from "@/components/ui/button";

export function RetryButton() {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
      Try again
    </Button>
  );
}
