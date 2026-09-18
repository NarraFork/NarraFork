import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { createPostgresKnowledgeReadStore } from "../postgres-read-store";
import { sqliteKnowledgeReadStore } from "../sqlite-read-store";
import {
	knowledgeReadStore,
	resolveKnowledgeReadStore,
	setKnowledgeReadStore,
	synchronousKnowledgeInjectionReads,
} from "../store";

describe("P6 knowledge read boundary", () => {
	test("defaults to SQLite and refuses an unbound PG selection", () => {
		expect(resolveKnowledgeReadStore({}, undefined)).toBe(sqliteKnowledgeReadStore);
		expect(() => resolveKnowledgeReadStore({ readBackend: "postgres" }, undefined)).toThrow();
	});
	test("injected PG reads never fall through to the synchronous SQLite compatibility path", () => {
		const previous = knowledgeReadStore;
		const injected = createPostgresKnowledgeReadStore({} as BunSQLDatabase);
		try {
			setKnowledgeReadStore(injected);
			expect(knowledgeReadStore).toBe(injected);
			expect(resolveKnowledgeReadStore({ readBackend: "postgres" }, injected)).toBe(injected);
			expect(() => synchronousKnowledgeInjectionReads()).toThrow("unavailable on PostgreSQL");
		} finally {
			setKnowledgeReadStore(previous);
		}
	});
	for (const file of ["postgres-read-store.ts", "postgres-write-store.ts"]) {
		test(`${file} bundles without any SQLite driver or startup`, async () => {
			const result = await Bun.build({
				entrypoints: [resolve(import.meta.dir, "..", file)],
				target: "bun",
			});
			expect(result.success).toBe(true);
			const source = await result.outputs[0].text();
			for (const forbidden of [
				"bun:sqlite",
				"drizzle-orm/bun-sqlite",
				"acquireInstanceLock",
				"markDatabaseCleanShutdown",
				"PRAGMA busy_timeout",
			])
				expect(source).not.toContain(forbidden);
			expect(source).toContain(
				file === "postgres-read-store.ts"
					? "createPostgresKnowledgeReadStore"
					: "createPostgresKnowledgeWriteStore",
			);
		});
	}
	test("the five service entry points import no global database handle", () => {
		for (const file of [
			"knowledge-service.ts",
			"knowledge-link-service.ts",
			"knowledge-acl.ts",
			"knowledge-audit.ts",
			"knowledge-notify.ts",
		]) {
			const source = readFileSync(resolve(import.meta.dir, "../..", file), "utf8");
			expect(source).not.toMatch(/from\s+["'](?:\.\.\/db|@server\/db)["']/);
			expect(source).not.toMatch(/\bdb\.(?:query|insert|update|delete|transaction)\b/);
		}
	});
});
