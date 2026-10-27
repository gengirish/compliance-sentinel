import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";
import { unauthorized } from "@/lib/auth";

/** Streams a run's report through this app so the API token never reaches the browser. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "invalid run id" }, { status: 400 });

  const res = await apiFetch(`/reports/${id}`, { redirect: "manual", timeoutMs: 30_000 });
  // In production the API answers with a short-lived signed bucket link.
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) return NextResponse.redirect(location, 302);
  if (!res.ok) return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });

  return new Response(res.body, {
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}
