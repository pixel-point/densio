import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { runAdminCommand } from "./admin/admin-command.ts";
import { loadConfig } from "./config.ts";
import { migrateDatabase, openDatabase } from "./database/database.ts";

const config = loadConfig(process.env);
mkdirSync(dirname(config.databasePath), { recursive: true });
const database = openDatabase(config.databasePath);
migrateDatabase(database);

const result = await runAdminCommand(database, process.argv.slice(2), {
  grantedBy: process.env.USER ?? "local-operator",
  now: Date.now,
});
database.close();

if ("output" in result) process.stdout.write(`${JSON.stringify(result.output)}\n`);
if ("error" in result) process.stderr.write(`${JSON.stringify(result.error)}\n`);
process.exitCode = result.exitCode;
