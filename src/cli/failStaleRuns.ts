import { parseArgs } from "node:util";
import { config } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { failStaleRuns } from "../pipeline/watchdog.js";

// One-off repair for runs orphaned before the watchdog existed, e.g. run #2:
//   pnpm runs:fail-stale --run 2 --dry-run
//   pnpm runs:fail-stale --run 2
const { values } = parseArgs({
  options: {
    run: { type: "string", multiple: true },
    "older-than": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const runIds = (values.run ?? []).map(Number);
if (runIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("--run takes a positive run id");
const maxAgeMinutes = values["older-than"] ? Number(values["older-than"]) : config.RUN_TIMEOUT_MINUTES;
if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) throw new Error("--older-than takes a number of minutes");

const handle = await openMigratedDb();
try {
  const ids = await failStaleRuns(handle.db, { maxAgeMinutes, runIds, dryRun: values["dry-run"] });
  const verb = values["dry-run"] ? "Would mark" : "Marked";
  console.log(
    ids.length
      ? `${verb} ${ids.length} run(s) failed on ${handle.driver}: ${ids.map((id) => `#${id}`).join(", ")}`
      : `No run has been running for more than ${maxAgeMinutes} minutes (${handle.driver}).`,
  );
} finally {
  await handle.close();
}
