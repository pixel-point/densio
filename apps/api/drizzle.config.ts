import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/database.sqlite",
  },
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/database/schema.ts",
});
