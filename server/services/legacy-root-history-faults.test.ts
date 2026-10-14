import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPendingMigrationsByHash } from "../db/run-migrations";
import type { LegacyRootHistoryInput } from "./legacy-root-history-contract";

const actual = { ...fs };
let target = "";
let fault: "access" | "inode" | "truncate" | "database-inode" | null = null;
let databaseStats = 0;
mock.module("node:fs", () => ({
	...actual,
	lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
		if (fault === "database-inode" && String(args[0]) === target && ++databaseStats === 3) {
			fault = null;
			actual.copyFileSync(target, `${target}.replacement`);
			actual.renameSync(`${target}.replacement`, target);
		}
		if (fault === "access" && String(args[0]) === target) {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		}
		return actual.lstatSync(...args);
	},
	openSync: (...args: Parameters<typeof fs.openSync>) => {
		if (fault === "inode" && String(args[0]) === target) {
			fault = null;
			actual.renameSync(target, `${target}.old`);
			actual.writeFileSync(target, "ref: refs/heads/main\n");
		}
		return actual.openSync(...args);
	},
	readSync: (...args: Parameters<typeof fs.readSync>) => {
		const result = actual.readSync(...args);
		if (fault === "truncate") {
			fault = null;
			actual.truncateSync(target, 0);
		}
		return result;
	},
}));
const { inspectLegacyRootHistoryReadonly } = await import("./legacy-root-history-validator");
let directory: string;
let input: LegacyRootHistoryInput;
beforeEach(() => {
	directory = actual.mkdtempSync(join(tmpdir(), "nf-root-history-fault-"));
	const databasePath = join(directory, "history.db");
	const database = new Database(databasePath);
	applyPendingMigrationsByHash(database, resolve("drizzle"));
	database.exec("PRAGMA foreign_keys=OFF");
	database.run(
		"INSERT INTO chapters (id,project_id,title,branch,base_branch,created_at,updated_at) VALUES ('c','p','root','main','main','now','now')",
	);
	database.close();
	const shadow = join(directory, "shadow");
	actual.mkdirSync(shadow);
	target = join(shadow, "HEAD");
	actual.writeFileSync(target, "ref: refs/heads/main\n");
	input = {
		databasePath,
		projectId: "p",
		chapterIds: ["c"],
		narratorIds: [],
		workspacePaths: [join(directory, "repo")],
		snapshotShadowKeys: [],
		shadowDirectories: [shadow],
	};
});
afterEach(() => {
	fault = null;
	actual.rmSync(directory, { recursive: true, force: true });
});
for (const scenario of ["access", "inode", "truncate"] as const) {
	test(`shadow ${scenario} failure is unknown rather than empty`, () => {
		fault = scenario;
		expect(inspectLegacyRootHistoryReadonly(input).status).toBe("unknown");
	});
}

test("main database replacement during inspection is unknown", () => {
	target = input.databasePath;
	databaseStats = 0;
	fault = "database-inode";
	expect(inspectLegacyRootHistoryReadonly(input).status).toBe("unknown");
});

test("database inode change changes the proof digest", () => {
	const first = inspectLegacyRootHistoryReadonly(input);
	actual.copyFileSync(input.databasePath, `${input.databasePath}.replacement`);
	actual.renameSync(`${input.databasePath}.replacement`, input.databasePath);
	const second = inspectLegacyRootHistoryReadonly(input);
	expect(first.status).toBe("empty");
	expect(second.status).toBe("empty");
	expect(second.digest).not.toBe(first.digest);
});
