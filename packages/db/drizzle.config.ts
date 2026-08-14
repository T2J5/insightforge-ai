import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

config({
  path: resolve(currentDirectory, "../../.env"),
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is not defined");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
});
