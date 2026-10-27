import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import { unauthorized } from "@/lib/auth";

/** `true`/`false` switches the source; `null` hands it back to its SCRAPE_* flag. */
const SourceSettingBody = z.strictObject({ enabled: z.boolean().nullable() });

/** Switches one scraper on or off on the Sentinel API. Takes effect from the next run. */
export async function PUT(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { name } = await params;
  if (!/^[a-z0-9-]+$/.test(name)) return NextResponse.json({ error: "invalid source name" }, { status: 400 });

  const body = SourceSettingBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return NextResponse.json({ error: "expected { enabled: true | false | null }" }, { status: 400 });

  try {
    const res = await apiFetch(`/settings/sources/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.data),
    });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof ApiError && err.status ? err.status : 502 });
  }
}
