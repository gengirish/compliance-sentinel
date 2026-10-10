import { targetRepoPath } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { loadDemoRules } from "../pipeline/run.js";
import { createEmbedder } from "../rag/embed.js";
import { indexRepo } from "../rag/indexRepo.js";
import { embedRule, retrieveCodeChunks, retrieveRuleChunks } from "../rag/retrieve.js";
import { persistChanges, upsertSource } from "../scrape/diff.js";

// Prints top-k rule and code chunks for hand-written queries against the demo
// corpus, so retrieval quality can be eyeballed after changing the chunker or embedder.
const QUERIES: { query: string; kind: "rule" | "code" }[] = [
  { query: "how long can personal data be kept", kind: "rule" },
  { query: "deadline to report a data breach to the regulator", kind: "rule" },
  { query: "proof that the user agreed to marketing", kind: "rule" },
  { query: "encryption of customer information in transit and at rest", kind: "rule" },
  { query: "who is allowed to access customer information", kind: "rule" },
  { query: "logging social security numbers", kind: "code" },
  { query: "database password configuration", kind: "code" },
  { query: "scheduled background jobs", kind: "code" },
  { query: "security incident handling", kind: "code" },
  { query: "role based access control middleware", kind: "code" },
];

const handle = await openMigratedDb({ pgliteDir: "memory" });
try {
  const { db } = handle;
  const embedder = createEmbedder(db);
  for (const { def, rules } of loadDemoRules()) {
    const sourceId = await upsertSource(db, def);
    for (const rule of (await persistChanges(db, sourceId, rules, { force: true })).changed) {
      await embedRule(db, embedder, rule);
    }
  }
  const index = await indexRepo(db, embedder, targetRepoPath());
  console.log(`Embedder: ${embedder.model}\n`);

  for (const { query, kind } of QUERIES) {
    console.log(`Q (${kind}): ${query}`);
    if (kind === "rule") {
      for (const hit of await retrieveRuleChunks(db, embedder, query, 3)) {
        console.log(`   ${hit.distance.toFixed(3)}  ${hit.sectionRef ?? "-"}: ${hit.text.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    } else {
      for (const hit of await retrieveCodeChunks(db, embedder, query, 3, index)) {
        console.log(`   ${hit.distance.toFixed(3)}  ${hit.path}:${hit.startLine}-${hit.endLine}`);
      }
    }
    console.log();
  }
} finally {
  await handle.close();
}
