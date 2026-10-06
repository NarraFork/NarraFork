import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./server/db/schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: resolve(homedir(), ".narrafork", "narrafork.db"),
	},
	out: "./drizzle",
	tablesFilter: ["!*_fts*"],
});
