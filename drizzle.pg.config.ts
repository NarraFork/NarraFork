import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./server/db/postgres-schema.ts",
	dialect: "postgresql",
	dbCredentials: {
		url: "postgresql://baseline:baseline@127.0.0.1:5432/baseline",
	},
	out: "./drizzle-postgres",
});
