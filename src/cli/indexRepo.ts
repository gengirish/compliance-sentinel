import { targetRepoPath } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { createEmbedder } from "../rag/embed.js";
import { indexRepo } from "../rag/indexRepo.js";

const root = process.argv[2] ?? targetRepoPath();
const handle = await openMigratedDb();
try {
  const result = await indexRepo(handle.db, createEmbedder(handle.db), root);
  console.log(
    result.reindexed
      ? `Indexed ${result.repo} at ${result.commitSha}: ${result.chunks} chunks.`
      : `${result.repo} at ${result.commitSha} is already indexed.`,
  );
} finally {
  await handle.close();
}
