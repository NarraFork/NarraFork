import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite as schemaTemplate } from "@server/db";
import * as schema from "@server/db/schema";
import { readDomainTask } from "@server/db/worker-read";
import {
	assertDbReadersReady,
	closeReadDatabase,
	resetDbWorkerPoolForTest,
} from "@server/lib/db-worker/pool";
import { settings } from "@server/lib/settings";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openSchemaCopyAt } from "../../../../tests/sqlite-schema-image";
import { isTrustedReviewBoundary, signReviewBoundaryRuleId } from "../../narrator-review-boundary";
import { executionPolicyRevision } from "../engine";
import { EXECUTION_POLICY_FACTS_MAX_BYTES } from "../facts";
import { readExecutionPolicyFacts, validateExecutionPolicyFactsInput } from "../facts-reader";
import { captureExecutionPolicySettings, materializeExecutionPolicy } from "../materializer";
import { ExecutionPolicyRepository } from "../repository";

const stamp = "2026-01-01T00:00:00.000Z";
let directory: string;
let sqlite: Database;
let store: ReturnType<typeof drizzle>;
let repository: ExecutionPolicyRepository;
let originalSettings: typeof settings;
let originalWorker: string | undefined;

function seed() {
	store
		.insert(schema.projects)
		.values([
			{
				id: "source-project",
				name: "source",
				gitPath: "/source",
				createdAt: stamp,
				updatedAt: stamp,
				chapterSettings: { commandBlacklist: [{ pattern: "source-deny", enabled: true }] },
			},
			{
				id: "primary-project",
				name: "primary",
				gitPath: "/primary",
				createdAt: stamp,
				updatedAt: stamp,
				chapterSettings: { commandBlacklist: [{ pattern: "primary-deny", enabled: true }] },
			},
			{
				id: "additional-project",
				name: "additional",
				gitPath: "/additional",
				createdAt: stamp,
				updatedAt: stamp,
				chapterSettings: { commandWhitelist: [{ pattern: "additional-allow", enabled: true }] },
			},
		])
		.run();
	store
		.insert(schema.narrators)
		.values([
			{ id: "root", contextProjectId: "source-project", createdAt: stamp, updatedAt: stamp },
			{ id: "child", policySourceNarratorId: "root", createdAt: stamp, updatedAt: stamp },
			{ id: "sibling", parentNarratorId: "root", createdAt: stamp, updatedAt: stamp },
		])
		.run();
	store
		.insert(schema.narratorProjectLinks)
		.values([
			{
				narratorId: "child",
				projectId: "primary-project",
				role: "primary",
				source: "cwd",
				updatedAt: stamp,
			},
			{
				narratorId: "child",
				projectId: "additional-project",
				role: "additional",
				source: "cwd",
				updatedAt: stamp,
			},
		])
		.run();
	store
		.insert(schema.narratorWhitelistDirs)
		.values({
			id: "allow-dir",
			narratorId: "child",
			path: "C:\\Allowed",
			pathFlavor: "windows",
			pathKey: "c:/allowed",
			accessLevel: "readWrite",
			targetKind: "device",
			targetValue: "remote",
			createdAt: stamp,
		})
		.run();
	store
		.insert(schema.narratorBlacklistDirs)
		.values([
			{
				id: signReviewBoundaryRuleId("root", "/signed"),
				narratorId: "root",
				path: "/signed",
				targetKind: "host",
				deviceScope: "local",
				enabled: false,
				createdAt: stamp,
			},
			{
				id: "review-boundary:unsigned",
				narratorId: "child",
				path: "/unsigned",
				targetKind: "host",
				deviceScope: "local",
				enabled: false,
				createdAt: stamp,
			},
		])
		.run();
	store
		.insert(schema.narratorWhitelistCmds)
		.values([
			{ id: "root-allow", narratorId: "root", pattern: "root-allow", createdAt: stamp },
			{ id: "child-allow", narratorId: "child", pattern: "child-allow", createdAt: stamp },
			{ id: "sibling-allow", narratorId: "sibling", pattern: "sibling-allow", createdAt: stamp },
		])
		.run();
	store
		.insert(schema.narratorBlacklistCmds)
		.values({
			id: "root-deny",
			narratorId: "root",
			pattern: "root-deny",
			denyPrompt: "deny",
			createdAt: stamp,
		})
		.run();
}

function factsNow() {
	return sqlite.transaction(() =>
		readExecutionPolicyFacts(sqlite, { narratorId: "child" }, new AbortController().signal),
	)();
}

beforeEach(async () => {
	originalSettings = structuredClone(settings);
	originalWorker = process.env.NARRAFORK_DB_WORKER;
	delete process.env.NARRAFORK_DB_WORKER;
	settings.agent.whitelistDirs = [];
	settings.agent.blacklistDirs = [];
	settings.agent.commandWhitelist = [{ pattern: "global-allow", enabled: true }];
	settings.agent.commandBlacklist = [];
	directory = mkdtempSync(join(tmpdir(), "execution-policy-worker-"));
	sqlite = openSchemaCopyAt(schemaTemplate, join(directory, "policy.db"));
	sqlite.run("PRAGMA journal_mode = WAL");
	store = drizzle(sqlite);
	repository = new ExecutionPolicyRepository(store);
	resetDbWorkerPoolForTest();
	seed();
	await assertDbReadersReady(sqlite.filename, { timeoutMs: 30_000 });
});

afterEach(async () => {
	await closeReadDatabase(sqlite.filename);
	sqlite.close();
	rmSync(directory, { recursive: true, force: true });
	Object.assign(settings, originalSettings);
	if (originalWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = originalWorker;
});

describe("execution policy worker facts", () => {
	test("WAL load uses no main SQL and preserves upstream primary-project policy/hash", async () => {
		const expected = repository.loadNow("child");
		const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
			throw new Error("main prepare");
		});
		const query = spyOn(sqlite, "query").mockImplementation(() => {
			throw new Error("main query");
		});
		let actual: Awaited<ReturnType<typeof repository.load>>;
		try {
			actual = await repository.load("child");
		} finally {
			prepare.mockRestore();
			query.mockRestore();
		}
		expect(actual).toEqual(expected);
		expect(executionPolicyRevision(actual)).toBe(executionPolicyRevision(expected));
		expect(actual.inheritedNarratorIds).toEqual(["child", "root"]);
		expect(actual.projectId).toBe("primary-project");
		expect(actual.projectGitPath).toBe("/primary");
		expect(actual.commandBlacklist.map((rule) => rule.pattern)).toEqual([
			"primary-deny",
			"source-deny",
			"root-deny",
		]);
		expect(actual.commandWhitelist.map((rule) => rule.pattern)).toEqual([
			"global-allow",
			"child-allow",
			"root-allow",
		]);
		expect(actual.directoryWhitelist[0]?.selector).toEqual({ kind: "device", deviceId: "remote" });
		expect(
			actual.directoryBlacklist.filter(isTrustedReviewBoundary).map((rule) => rule.path),
		).toEqual(["/signed"]);
		expect(actual.directoryBlacklist.find((rule) => rule.path === "/unsigned")?.enabled).toBe(
			false,
		);
	});

	test("explicit project overrides the primary link without admitting additional projects", async () => {
		store
			.update(schema.narrators)
			.set({ contextProjectId: "source-project" })
			.where(eq(schema.narrators.id, "child"))
			.run();
		const policy = await repository.load("child");
		expect(policy.projectId).toBe("source-project");
		expect(policy.projectGitPath).toBe("/source");
		expect(policy.commandBlacklist.map((rule) => rule.pattern)).toEqual([
			"source-deny",
			"root-deny",
		]);
		expect(policy.commandWhitelist.some((rule) => rule.pattern === "additional-allow")).toBe(false);
	});

	test("settings and instance signature verification are captured after the awaited facts", async () => {
		const before = await repository.load("child");
		const pending = repository.load("child");
		settings.agent.commandBlacklist = [{ pattern: "new-global-deny", enabled: true }];
		const after = await pending;
		expect(after.commandBlacklist[0]?.pattern).toBe("new-global-deny");
		expect(executionPolicyRevision(after)).not.toBe(executionPolicyRevision(before));
		const facts = factsNow();
		const snapshot = captureExecutionPolicySettings(facts);
		settings.agent.commandBlacklist = [];
		settings.auth.jwtSecret = "another-instance-secret";
		const stable = materializeExecutionPolicy(facts, snapshot);
		expect(stable.commandBlacklist[0]?.pattern).toBe("new-global-deny");
		expect(
			stable.directoryBlacklist.filter(isTrustedReviewBoundary).map((rule) => rule.path),
		).toEqual(["/signed"]);
	});

	test("loadNow(tx) remains synchronous and sees uncommitted rules", async () => {
		expect(() =>
			store.transaction((tx) => {
				tx.update(schema.narratorBlacklistCmds)
					.set({ pattern: "uncommitted" })
					.where(eq(schema.narratorBlacklistCmds.id, "root-deny"))
					.run();
				const policy = repository.loadNow("child", tx);
				expect(policy).not.toBeInstanceOf(Promise);
				expect(policy.commandBlacklist.at(-1)?.pattern).toBe("uncommitted");
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect((await repository.load("child")).commandBlacklist.at(-1)?.pattern).toBe("root-deny");
	});

	test("memory, transaction and unavailable worker reads reject without main-thread fallback", async () => {
		const memory = new Database(":memory:");
		try {
			await expect(
				new ExecutionPolicyRepository(drizzle(memory)).load("child"),
			).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
		} finally {
			memory.close();
		}
		let pending: Promise<unknown> | undefined;
		store.transaction(() => {
			pending = repository.load("child").then(
				() => null,
				(error: unknown) => error,
			);
		});
		expect(await pending).toMatchObject({ code: "DB_READ_UNSUPPORTED" });
		process.env.NARRAFORK_DB_WORKER = "off";
		resetDbWorkerPoolForTest();
		const select = spyOn(store, "select").mockImplementation(() => {
			throw new Error("main fallback");
		});
		try {
			await expect(repository.load("child")).rejects.toMatchObject({ code: "DB_READ_UNAVAILABLE" });
			expect(select).not.toHaveBeenCalled();
		} finally {
			select.mockRestore();
		}
	});

	test("project policy projection preserves duplicate-key precedence and omits unrelated prompts", async () => {
		const raw = `{"commandBlacklist":[{"pattern":"first"}],"commands":[{"prompt":"${"x".repeat(400000)}"}],"commandBlacklist":[{"pattern":"last"}],"whitelistDirs":null}`;
		sqlite.run("UPDATE projects SET chapter_settings = ? WHERE id = ?", [raw, "primary-project"]);
		const facts = await readDomainTask(
			sqlite,
			"executionPolicyFacts",
			{ narratorId: "child" },
			{ executionPolicy: "worker-required" },
		);
		expect(facts.projectRuleSets[0]?.commandBlacklist?.[0]?.pattern).toBe("last");
		expect(Object.hasOwn(facts.projectRuleSets[0] ?? {}, "commands")).toBe(false);
		expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThan(50000);
		expect(materializeExecutionPolicy(facts)).toEqual(repository.loadNow("child"));
	});

	test("one WAL snapshot includes chain, project and rules across a concurrent commit", () => {
		const writer = new Database(sqlite.filename);
		const original = sqlite.prepare.bind(sqlite);
		let changed = false;
		const prepare = spyOn(sqlite, "prepare").mockImplementation(
			(...args: Parameters<Database["prepare"]>) => {
				if (!changed && args[0].includes('from "projects"')) {
					changed = true;
					writer.transaction(() => {
						writer.run(
							"UPDATE narrator_blacklist_cmds SET pattern = 'concurrent-deny' WHERE id = 'root-deny'",
						);
						writer.run("UPDATE projects SET git_path = '/concurrent' WHERE id = 'primary-project'");
					})();
				}
				return original(...args);
			},
		);
		try {
			const facts = factsNow();
			expect(changed).toBe(true);
			expect(facts.projectGitPath).toBe("/primary");
			expect(facts.commandBlacklist[0]?.pattern).toBe("root-deny");
		} finally {
			prepare.mockRestore();
			writer.close();
		}
		expect(repository.loadNow("child").projectGitPath).toBe("/concurrent");
	});

	test("legal policies above generic byte observations remain complete", async () => {
		const prefix = `/${"a".repeat(4080)}`;
		store.transaction((tx) => {
			for (let i = 0; i < 600; i++)
				tx.insert(schema.narratorWhitelistDirs)
					.values({
						id: `large-${i}`,
						narratorId: "root",
						path: `${prefix}${i}`,
						pathKey: `${prefix}${i}`,
						pathFlavor: "posix",
						createdAt: stamp,
					})
					.run();
		});
		const facts = await readDomainTask(
			sqlite,
			"executionPolicyFacts",
			{ narratorId: "child" },
			{ executionPolicy: "worker-required" },
		);
		expect(Buffer.byteLength(JSON.stringify(facts))).toBeGreaterThan(4 * 1024 * 1024);
		expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThan(EXECUTION_POLICY_FACTS_MAX_BYTES);
		expect(materializeExecutionPolicy(facts).directoryWhitelist).toHaveLength(601);
		expect(executionPolicyRevision(materializeExecutionPolicy(facts))).toBe(
			executionPolicyRevision(repository.loadNow("child")),
		);
	});

	test("facts honor cancellation before opening any query", () => {
		const controller = new AbortController();
		controller.abort();
		const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
			throw new Error("main prepare");
		});
		try {
			expect(() =>
				readExecutionPolicyFacts(sqlite, { narratorId: "child" }, controller.signal),
			).toThrow("aborted");
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
		}
	});

	test("the registered policy-source depth remains bounded at sixteen", async () => {
		for (let index = 0; index < 17; index++)
			store
				.insert(schema.narrators)
				.values({
					id: `depth-${index}`,
					policySourceNarratorId: index === 0 ? null : `depth-${index - 1}`,
					createdAt: stamp,
					updatedAt: stamp,
				})
				.run();
		expect((await repository.load("depth-15")).inheritedNarratorIds).toHaveLength(16);
		let rejected = false;
		let rejection: unknown;
		try {
			await repository.load("depth-16");
		} catch (error) {
			rejected = true;
			rejection = error;
		}
		expect(rejected).toBe(true);
		expect(rejection).toMatchObject({ code: "DB_READ_FAILED" });
	});

	test("input, missing project, cycles and upstream per-table overflow reject explicitly", async () => {
		expect(validateExecutionPolicyFactsInput({ narratorId: "child" })).toBe(true);
		for (const input of [
			{ narratorId: "" },
			{ narratorId: "child", module: "x" },
			{ narratorId: "界".repeat(100) },
		])
			expect(validateExecutionPolicyFactsInput(input)).toBe(false);
		expect(() =>
			readExecutionPolicyFacts(sqlite, { narratorId: "child" }, new AbortController().signal),
		).toThrow("existing snapshot transaction");
		await expect(repository.load("missing")).rejects.toMatchObject({ code: "DB_READ_FAILED" });
		store
			.update(schema.narrators)
			.set({ contextProjectId: "missing-project" })
			.where(eq(schema.narrators.id, "child"))
			.run();
		await expect(repository.load("child")).rejects.toMatchObject({ code: "DB_READ_FAILED" });
		store
			.update(schema.narrators)
			.set({ contextProjectId: null })
			.where(eq(schema.narrators.id, "child"))
			.run();
		store
			.update(schema.narrators)
			.set({ policySourceNarratorId: "child" })
			.where(eq(schema.narrators.id, "root"))
			.run();
		await expect(repository.load("child")).rejects.toMatchObject({ code: "DB_READ_FAILED" });
		store
			.update(schema.narrators)
			.set({ policySourceNarratorId: null })
			.where(eq(schema.narrators.id, "root"))
			.run();
		store.transaction((tx) => {
			for (let i = 0; i < 2001; i++)
				tx.insert(schema.narratorBlacklistCmds)
					.values({ id: `over-${i}`, narratorId: "child", pattern: `over-${i}`, createdAt: stamp })
					.run();
		});
		await expect(repository.load("child")).rejects.toMatchObject({ code: "DB_READ_BUDGET" });
	});
});
