import { migrate, openDb } from "../db/client.js";

const handle = await openDb();
try {
  const ran = await migrate(handle.db);
  console.log(ran.length ? `Applied ${ran.length} migration(s) on ${handle.driver}: ${ran.join(", ")}` : `Schema is up to date (${handle.driver}).`);
} finally {
  await handle.close();
}
