import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";
import { resolvePgSchemaPath, resolvePgStageOut } from "./scripts/lib/postgres-kit";

// Generation/checks work on an isolated copy; runtime migrations use SQL + journal directly.
const root = resolve(import.meta.dir);

export default defineConfig({
	schema: resolvePgSchemaPath(root),
	dialect: "postgresql",
	dbCredentials: {
		url: "postgresql://baseline:baseline@127.0.0.1:5432/baseline",
	},
	out: resolvePgStageOut(root),
});
