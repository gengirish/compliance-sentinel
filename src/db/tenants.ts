import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { LOCAL_TENANT_ID, repos, tenants, type Repo, type Tenant } from "./schema.js";

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

/** The tenant of a GitHub App installation, created on first sight and renamed when the account is. */
export async function upsertInstallationTenant(db: Db, installationId: number, name: string): Promise<Tenant> {
  const [row] = await db
    .insert(tenants)
    .values({ name, githubInstallationId: installationId })
    .onConflictDoUpdate({ target: tenants.githubInstallationId, set: { name } })
    .returning();
  return row!;
}

export async function getTenant(db: Db, tenantId: number): Promise<Tenant | undefined> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return row;
}

export type GitHubRepoRef = { githubRepoId: number; fullName: string };

/**
 * Repositories an installation can see, active again if they had been removed. GitHub's repo
 * id is the key: a reinstall creates a new installation, and its repos move to that tenant.
 */
export async function upsertGitHubRepos(db: Db, tenantId: number, refs: GitHubRepoRef[]): Promise<Repo[]> {
  const out: Repo[] = [];
  for (const ref of refs) {
    const [row] = await db
      .insert(repos)
      .values({ tenantId, githubRepoId: ref.githubRepoId, fullName: ref.fullName })
      .onConflictDoUpdate({ target: repos.githubRepoId, set: { tenantId, fullName: ref.fullName, active: true } })
      .returning();
    out.push(row!);
  }
  return out;
}

/**
 * Turns an installation's repos on or off; `githubRepoIds` narrows it to some of them. Rows and
 * their runs are kept when switched off, since reports are evidence. Returns the rows changed.
 */
export async function setInstallationReposActive(
  db: Db,
  installationId: number,
  active: boolean,
  githubRepoIds?: number[],
): Promise<Repo[]> {
  const owner = db.select({ id: tenants.id }).from(tenants).where(eq(tenants.githubInstallationId, installationId));
  const where = [inArray(repos.tenantId, owner)];
  if (githubRepoIds) where.push(inArray(repos.githubRepoId, githubRepoIds.length ? githubRepoIds : [-1]));
  return db
    .update(repos)
    .set({ active })
    .where(and(...where))
    .returning();
}

export async function getRepo(db: Db, tenantId: number, repoId: number): Promise<Repo | undefined> {
  const [row] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.tenantId, tenantId)));
  return row;
}
