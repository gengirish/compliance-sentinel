import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Tenant } from "../db/schema.js";
import { setInstallationReposActive, upsertGitHubRepos, upsertInstallationTenant, type GitHubRepoRef } from "../db/tenants.js";
import { log } from "../log.js";
import type { AuditJobData } from "../queue/queue.js";

/**
 * GitHub App webhook events. Installation events keep tenants and repos in step with what the
 * App can see, and queue a baseline audit for every repository it gains. Pull requests and
 * pushes are acknowledged but not acted on until PR mode (plan §B3).
 */

const RepoRef = z.object({ id: z.number(), full_name: z.string() });
const Installation = z.object({ id: z.number(), account: z.object({ login: z.string() }).nullish() });

export const InstallationEvent = z.object({
  action: z.string(),
  installation: Installation,
  repositories: z.array(RepoRef).nullish(),
});

export const InstallationRepositoriesEvent = z.object({
  action: z.string(),
  installation: Installation,
  repositories_added: z.array(RepoRef).default([]),
  repositories_removed: z.array(RepoRef).default([]),
});

export type BaselineJob = { jobId: string; data: AuditJobData };

export type WebhookOutcome = {
  /** What happened, for the log line. */
  summary: string;
  /** Baseline audits to queue, one per repository gained. */
  jobs: BaselineJob[];
};

const refs = (list: z.infer<typeof RepoRef>[]): GitHubRepoRef[] => list.map((r) => ({ githubRepoId: r.id, fullName: r.full_name }));

/**
 * Job ids derive from the delivery id, so a redelivered webhook queues nothing new. BullMQ
 * rejects custom ids that contain ":".
 */
function baselineJobs(deliveryId: string, tenant: Tenant, repoIds: number[]): BaselineJob[] {
  return repoIds.map((repoId) => ({
    jobId: `gh-${deliveryId}-${repoId}`,
    data: { trigger: "install", tenantId: tenant.id, repoId, demo: true, rulePacks: tenant.rulePacks },
  }));
}

/** Applies one webhook delivery to the database and returns the audits it calls for. Throws on a malformed payload. */
export async function handleGitHubEvent(db: Db, event: string, deliveryId: string, payload: unknown): Promise<WebhookOutcome> {
  if (event === "installation") {
    const body = InstallationEvent.parse(payload);
    const installationId = body.installation.id;
    switch (body.action) {
      case "created": {
        const tenant = await upsertInstallationTenant(db, installationId, body.installation.account?.login ?? `installation ${installationId}`);
        const rows = await upsertGitHubRepos(db, tenant.id, refs(body.repositories ?? []));
        return {
          summary: `installation ${installationId} created: tenant ${tenant.id}, ${rows.length} repos`,
          jobs: baselineJobs(deliveryId, tenant, rows.map((r) => r.id)),
        };
      }
      case "deleted":
      case "suspend": {
        const rows = await setInstallationReposActive(db, installationId, false);
        return { summary: `installation ${installationId} ${body.action}: ${rows.length} repos inactive`, jobs: [] };
      }
      case "unsuspend": {
        const rows = await setInstallationReposActive(db, installationId, true);
        return { summary: `installation ${installationId} unsuspended: ${rows.length} repos active`, jobs: [] };
      }
      default:
        return { summary: `installation ${body.action} ignored`, jobs: [] };
    }
  }

  if (event === "installation_repositories") {
    const body = InstallationRepositoriesEvent.parse(payload);
    const installationId = body.installation.id;
    const tenant = await upsertInstallationTenant(db, installationId, body.installation.account?.login ?? `installation ${installationId}`);
    const added = await upsertGitHubRepos(db, tenant.id, refs(body.repositories_added));
    const removed = body.repositories_removed.length
      ? await setInstallationReposActive(db, installationId, false, body.repositories_removed.map((r) => r.id))
      : [];
    return {
      summary: `installation ${installationId}: ${added.length} repos added, ${removed.length} removed`,
      jobs: baselineJobs(deliveryId, tenant, added.map((r) => r.id)),
    };
  }

  if (event === "pull_request" || event === "push") {
    log.info("GitHub event received; PR mode is not built yet", { event, deliveryId });
    return { summary: `${event} not handled yet`, jobs: [] };
  }

  return { summary: `${event} ignored`, jobs: [] };
}
