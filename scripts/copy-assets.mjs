// Copies non-TS runtime assets (SQL migrations, report template) into dist/.
import { cpSync } from "node:fs";

cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
cpSync("src/report/template.html", "dist/report/template.html");
