"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Registers /sw.js in production and shows a toast when a new worker is waiting.
 * "Reload" tells the waiting worker to activate; the controllerchange that follows
 * reloads the page once so it runs on the new build.
 */
export function ServiceWorkerRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const sw = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | undefined;
    let cancelled = false;

    // Only an update if a worker already controls the page; the first install is silent.
    const offer = (worker: ServiceWorker | null) => {
      if (!cancelled && worker && sw.controller) setWaiting(worker);
    };

    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") offer(worker);
      });
    };

    const onUpdateFound = () => trackInstalling(registration?.installing ?? null);

    const onControllerChange = () => {
      if (reloading.current) return;
      reloading.current = true;
      window.location.reload();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        registration?.update().catch(() => {});
      }
    };

    sw.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisibility);

    sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (cancelled) return;
        registration = reg;
        offer(reg.waiting);
        trackInstalling(reg.installing);
        reg.addEventListener("updatefound", onUpdateFound);
      })
      .catch((err) => {
        console.warn("Service worker registration failed", err);
      });

    return () => {
      cancelled = true;
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibility);
      registration?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  if (!waiting) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-foreground shadow-lg"
    >
      <span>A new version is available</span>
      <Button size="sm" onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}>
        Reload
      </Button>
    </div>
  );
}
