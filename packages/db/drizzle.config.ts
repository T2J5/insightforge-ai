import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://insightforge:insightforge@localhost:54329/insightforge",
  },
});
