import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { LOCAL_TENANT_ID, repos, tenants, type Repo } from "./schema.js";

/** Header the dashboard sets server-side: a Clerk organization id, or `user:<id>` for a personal tenant. */
export const TENANT_HEADER = "x-sentinel-tenant";

/**
 * The tenant a request acts for. No header means the operator's local tenant, so the CLI,
 * the e2e mock and a dashboard deployed before tenancy keep working. A header that matches
 * no tenant gives null: the caller sees nothing rather than someone else's data.
 */
export async function resolveTenantId(db: Db, header: string | undefined): Promise<number | null> {
  const key = header?.trim();
  if (!key) return LOCAL_TENANT_ID;
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.clerkOrgId, key)).limit(1);
  return row?.id ?? null;
}

/** The repository row for `fullName` in this tenant, created on first use. */
export async function ensureRepo(db: Db, tenantId: number, fullName: string): Promise<Repo> {
  const [row] = await db
    .insert(repos)
    .values({ tenantId, fullName })
    .onConflictDoUpdate({ target: [repos.tenantId, repos.fullName], set: { fullName: sql`excluded.full_name` } })
    .returning();
  return row!;
}

export async function getRepo(db: Db, tenantId: number, repoId: number): Promise<Repo | undefined> {
  const [row] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.tenantId, tenantId)));
  return row;
}
