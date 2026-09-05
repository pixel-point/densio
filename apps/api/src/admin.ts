import { makeStorageTargets } from "./storage/storage-targets.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Stripe from "stripe";
import { makeStripeGateway } from "./billing/stripe-gateway.ts";

import { runAdminCommand } from "./admin/admin-command.ts";
import { loadConfig } from "./config.ts";
import { migrateDatabase, openDatabase } from "./database/database.ts";

const config = loadConfig(process.env);
mkdirSync(dirname(config.databasePath), { recursive: true });
const database = openDatabase(config.databasePath);
migrateDatabase(database);

const result = await runAdminCommand(database, process.argv.slice(2), {
  storage: makeStorageTargets(database, config, {
    now: Date.now,
    credentialKeys: config.storage.credentialKeys,
    activeCredentialKey: config.storage.activeCredentialKey,
  }),
  grantedBy: process.env.USER ?? "local-operator",
  now: Date.now,
  ...(config.stripeSecretKey === ""
    ? {}
    : { gateway: makeStripeGateway(new Stripe(config.stripeSecretKey)) }),
});
database.close();

if ("output" in result) process.stdout.write(`${JSON.stringify(result.output)}\n`);
if ("error" in result) process.stderr.write(`${JSON.stringify(result.error)}\n`);
process.exitCode = result.exitCode;
