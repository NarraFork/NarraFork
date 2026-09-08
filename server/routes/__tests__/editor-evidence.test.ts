import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import iconv from "iconv-lite";
import type { FileChangeState } from "../../../shared/file-change-protocol";
import { testEnvironment } from "../../../tests/preload";
import { app } from "../../app";
import { db, sqlite } from "../../db";
import {
	aclGrants,
	fileAttributions,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileChangeStorageBudgets,
	narratorFileSnapshots,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/local-backend";
import { writeTool } from "../../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../../lib/agent/types";
import { createToken } from "../../lib/auth";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import { settings } from "../../lib/settings";
import { type FileChangeLocalIo, fileChangeLocalIo } from "../../services/file-change-local-io";
import {
	executeEditorFileChange,
	LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "../../services/file-change-runtime";
import * as fileEditInterject from "../../services/file-edit-interject";
import * as sessionState from "../../services/narrator-session-state";
import { worktreeTreeSnapshot } from "../../services/worktree-tree-snapshot";

// Actual app, session JWT, application DB, ACL, local backend and journal. The
// preload owns every file/database here; only faults and synchronization points
// are injected. Never reset the process coordinator or the default runtime.
let workspace: string;
let narratorId: string;
let userId: string;
let token: string;
let runtime: LocalFileChangeRuntime;
let io: FileChangeLocalIo;
let applyCalls: number;
const restorers: (() => void)[] = [];
const triggers: string[] = [];

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(getNarraforkHome()).toBe(testEnvironment.narraforkHome);
	workspace = await mkdtemp(join(testEnvironment.isolatedHome, "editor-evidence-"));
	userId = generateId();
	narratorId = generateId();
	const now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			cwd: workspace,
			title: "Editor context, not its author",
			ownerUserId: userId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	token = await createToken(userId, "user");
	settings.chapters.treeSnapshotsEnabled = false;
	applyCalls = 0;
	io = {
		...fileChangeLocalIo,
		async apply(input) {
			applyCalls++;
			await fileChangeLocalIo.apply(input);
		},
	};
	runtime = new LocalFileChangeRuntime({ db, privateRoot: getNarraforkHome(), io });
});

afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) restore();
	for (const name of triggers.splice(0)) sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`);
	// Evidence is deliberately retained in the disposable DB; no cleanup bypasses a
	// durable recovery barrier or makes later tests dependent on erasing unknowns.
	await rm(workspace, { recursive: true, force: true });
});

function hash(text: string) {
	return createHash("sha256").update(text).digest("hex");
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function save(body: Record<string, unknown>, useDefault = false) {
	const send = async () => {
		const response = await app.request("http://localhost/api/fs/write", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ narratorId, ...body }),
		});
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	};
	return useDefault ? send() : withLocalFileChangeRuntime(runtime, send);
}
async function source(path: string) {
	const response = await app.request(
		`http://localhost/api/fs/edit-source?path=${encodeURIComponent(path)}`,
		{
			headers: { authorization: `Bearer ${token}` },
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { hash: string; encoding: string; content: string };
}
function operations() {
	return db
		.select()
		.from(fileChangeOperations)
		.where(eq(fileChangeOperations.narratorId, narratorId))
		.limit(20)
		.all();
}
function effects() {
	const ids = operations().map((operation) => operation.id);
	return ids.length
		? db
				.select()
				.from(fileChangeEffects)
				.where(inArray(fileChangeEffects.operationId, ids))
				.limit(20)
				.all()
		: [];
}
function projections() {
	const ids = operations().map((operation) => operation.id);
	return ids.length
		? db
				.select()
				.from(fileAttributions)
				.where(inArray(fileAttributions.operationId, ids))
				.limit(20)
				.all()
		: [];
}
async function bytes(state: FileChangeState) {
	if (state.kind === "absent") return null;
	if (state.kind !== "regular") throw new Error("Expected regular raw evidence");
	return (await runtime.initialize()).store.readBytes(state.blob);
}
function scope() {
	const value = db
		.select()
		.from(fileChangeScopes)
		.where(eq(fileChangeScopes.canonicalRoot, workspace))
		.get();
	if (!value) throw new Error("Expected real coordinator scope");
	return value;
}
async function toolContext(path: string): Promise<ToolContext> {
	const identity = await localBackend.resolvePathIdentity(path);
	const target: ToolExecutionTarget = Object.freeze({
		deviceId: "local",
		backendKind: "local",
		cwd: workspace,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: identity.lexicalPath,
		canonicalPath: identity.canonicalPath,
		runtimeGeneration: localBackend.runtimeGeneration,
		selectionSource: "local_default",
	});
	const toolCallId = generateId();
	const toolUseId = generateId();
	const messageId = generateId();
	const now = new Date().toISOString();
	db.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: now })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			executionDeviceId: "local",
			executionCwd: workspace,
			executionPathFlavor: target.pathFlavor,
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
			runtimeGeneration: target.runtimeGeneration,
			createdAt: now,
		})
		.run();
	return {
		narratorId,
		userId,
		cwd: workspace,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: toolUseId,
		toolCallBinding: Object.freeze({ toolCallId, attempt: 1 }),
		executionTarget: target,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}
function failSql(table: string, event: string, predicate: string) {
	const name = `editor_failure_${triggers.length}`;
	triggers.push(name);
	sqlite.exec(
		`CREATE TEMP TRIGGER ${name} BEFORE ${event} ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'injected editor journal failure'); END`,
	);
}

describe("real editor actual-byte evidence", () => {
	test.skipIf(process.platform === "win32")(
		"default runtime accepts 0700 HOME / 0775 data and stores one human receipt",
		async () => {
			const home = testEnvironment.isolatedHome;
			const data = getNarraforkHome();
			const homeMode = (await lstat(home)).mode & 0o7777;
			const dataMode = (await lstat(data)).mode & 0o7777;
			try {
				await chmod(home, 0o700);
				await chmod(data, 0o775);
				const path = join(workspace, "default.txt");
				const saved = await save(
					{ path, content: "human\n", userId: "forged", actor: { kind: "primary" } },
					true,
				);
				expect(saved.status).toBe(200);
				expect(saved.json.fileChangeEvidence).toMatchObject({
					version: 2,
					grade: "measured",
					settlement: "settled",
				});
				expect(await readFile(path, "utf8")).toBe("human\n");
				expect(operations()).toHaveLength(1);
				expect(operations()[0]).toMatchObject({
					sourceKind: "editor",
					attempt: 1,
					toolCallId: null,
					toolUseId: null,
					ownerUserId: userId,
					narratorId,
					executionOutcome: "succeeded",
					settlement: "settled",
					actorJson: { kind: "human", userId, narratorId: null, subjectKey: `user:${userId}` },
				});
				expect(operations()[0].sourceId).toHaveLength(21);
				expect(effects()).toHaveLength(1);
				expect(effects()[0]).toMatchObject({
					executionConfirmed: true,
					attributionGrade: "measured",
					linesAdded: 1,
					linesRemoved: 0,
				});
				expect(projections()).toHaveLength(1);
				expect(projections()[0]).toMatchObject({
					action: "human",
					narratorId: null,
					userId,
					linesAdded: 1,
					linesRemoved: 0,
				});
				expect(
					db
						.select()
						.from(narratorToolCalls)
						.where(eq(narratorToolCalls.narratorId, narratorId))
						.limit(1)
						.all(),
				).toEqual([]);
				expect(
					db
						.select()
						.from(narratorFileSnapshots)
						.where(eq(narratorFileSnapshots.narratorId, narratorId))
						.limit(1)
						.all(),
				).toEqual([]);
				expect(await bytes(effects()[0].intendedAfterStateJson)).toEqual(Buffer.from("human\n"));
				expect((await lstat(data)).mode & 0o777).toBe(0o775);
				expect((await lstat(join(data, "file-change-blobs"))).mode & 0o777).toBe(0o700);
				expect((await lstat(join(data, "file-change-source.json"))).mode & 0o777).toBe(0o600);
			} finally {
				await chmod(home, homeMode);
				await chmod(data, dataMode);
			}
		},
	);

	test("production defaults share source and scope between human save and real Write", async () => {
		const path = join(workspace, "shared-defaults.txt");
		expect((await save({ path, content: "human before\n" }, true)).status).toBe(200);
		const result = await writeTool.execute(
			{ file_path: path, content: "agent after\n" },
			await toolContext(path),
		);
		expect(result.isError).toBeUndefined();
		const records = operations();
		expect(records).toHaveLength(2);
		expect(new Set(records.map((record) => record.sourceInstanceId)).size).toBe(1);
		const editor = records.find((record) => record.sourceKind === "editor");
		const tool = records.find((record) => record.sourceKind === "tool");
		expect(editor).toBeDefined();
		expect(tool).toBeDefined();
		const fileEffects = effects();
		expect(new Set(fileEffects.map((effect) => effect.scopeId)).size).toBe(1);
		expect(fileEffects.find((effect) => effect.operationId === tool?.id)?.beforeStateJson).toEqual(
			fileEffects.find((effect) => effect.operationId === editor?.id)?.intendedAfterStateJson,
		);
		expect(projections().filter((projection) => projection.action === "human")).toHaveLength(1);
		expect(projections()).toHaveLength(2);
		expect(await readFile(path, "utf8")).toBe("agent after\n");
	});

	test("GBK + CRLF keeps exact before/intended/observed bytes and measured one-line stats", async () => {
		const path = join(workspace, "gbk.txt");
		const unchanged = "中文内容测试，编码检测需要足够的样本。\r\n";
		const before = iconv.encode(`你好\r\n${unchanged}`, "gbk");
		const after = iconv.encode(`您好\r\n${unchanged}`, "gbk");
		await writeFile(path, before);
		const opened = await source(path);
		expect(opened.encoding.toLowerCase()).not.toBe("utf-8");
		const saved = await save({
			path,
			content: `您好\n${unchanged.replaceAll("\r\n", "\n")}`,
			baseHash: opened.hash,
			encoding: opened.encoding,
		});
		expect(saved.status).toBe(200);
		expect(await readFile(path)).toEqual(Buffer.from(after));
		const effect = effects()[0];
		expect(await bytes(effect.beforeStateJson)).toEqual(before);
		expect(await bytes(effect.intendedAfterStateJson)).toEqual(after);
		expect(effect.observedAfterStateJson).toEqual(effect.intendedAfterStateJson);
		expect(effect).toMatchObject({ linesAdded: 1, linesRemoved: 1 });
		expect(saved.json.hash).toBe(hash(`您好\r\n${unchanged}`));
	});

	test("create without hash is exclusive; expected-existing deletion conflicts without recreating parents", async () => {
		const path = join(workspace, "gone", "file.txt");
		await mkdir(join(workspace, "gone"));
		await writeFile(path, "old");
		await rm(join(workspace, "gone"), { recursive: true });
		const deleted = await save({ path, content: "new", baseHash: hash("old") });
		expect(deleted).toMatchObject({
			status: 409,
			json: { code: "STALE_WRITE", currentHash: null },
		});
		expect(await lstat(join(workspace, "gone")).catch(() => null)).toBeNull();
		expect(applyCalls).toBe(0);
		expect((await save({ path, content: "new" })).status).toBe(200);
		expect((await save({ path, content: "clobber" })).status).toBe(409);
		expect(applyCalls).toBe(1);
		expect(await readFile(path, "utf8")).toBe("new");
	});

	test("binary, readonly and oversized original files are refused before intent/IO", async () => {
		for (const [name, content, mode] of [
			["binary", Buffer.from([0, 1, 255]), 0o600],
			["readonly", Buffer.from("no"), 0o444],
			["large", Buffer.alloc(1024 * 1024 + 1, 120), 0o600],
		] as const) {
			const path = join(workspace, name);
			await writeFile(path, content);
			await chmod(path, mode);
			expect((await save({ path, content: "replacement", baseHash: hash("old") })).status).toBe(
				400,
			);
			expect(await readFile(path)).toEqual(content);
		}
		expect(applyCalls).toBe(0);
		expect(operations()).toHaveLength(0);
	});

	test("EACCES before is unknown, not an absent-file creation", async () => {
		const path = join(workspace, "permission.txt");
		await writeFile(path, "old");
		io.read = async () => {
			throw Object.assign(new Error("EACCES injected"), { code: "EACCES" });
		};
		expect((await save({ path, content: "new" })).status).toBe(500);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(applyCalls).toBe(0);
		expect(operations()).toHaveLength(0);
	});

	test("extra writable roots retain an independent evidence scope and human projection", async () => {
		const outside = await mkdtemp(join(testEnvironment.isolatedHome, "editor-extra-"));
		try {
			settings.paths.extraWritableDirs = [outside];
			const path = join(outside, "note.txt");
			expect((await save({ path, content: "outside\n" })).status).toBe(200);
			const effect = effects()[0];
			expect(effect.identityJson).toMatchObject({
				canonicalPath: path,
				deviceId: "local",
			});
			expect(projections()[0]).toMatchObject({
				workspacePath: outside,
				filePath: "note.txt",
				action: "human",
				narratorId: null,
				userId,
			});
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("editor/tool shared lease and authorization boundaries", () => {
	test("real Write wins concurrent save: editor baseHash conflicts, never consumes tool bytes", async () => {
		const path = join(workspace, "concurrent.txt");
		await writeFile(path, "baseline\n");
		const entered = deferred();
		const release = deferred();
		const queued = deferred();
		const originalApply = io.apply;
		io.apply = async (input) => {
			entered.resolve();
			await release.promise;
			await originalApply(input);
		};
		const withWrite = runtime.coordinator.withWrite.bind(runtime.coordinator);
		let admissions = 0;
		const spy = spyOn(runtime.coordinator, "withWrite").mockImplementation((request, body) => {
			if (++admissions === 2) queued.resolve();
			return withWrite(request, body);
		});
		restorers.push(() => spy.mockRestore());
		const context = await toolContext(path);
		const tool = withLocalFileChangeRuntime(runtime, () =>
			writeTool.execute({ file_path: path, content: "tool\n" }, context),
		);
		await entered.promise;
		const editor = save({ path, content: "human\n", baseHash: hash("baseline\n") });
		try {
			await queued.promise;
		} finally {
			release.resolve();
		}
		expect((await tool).isError).toBeUndefined();
		expect(await editor).toMatchObject({
			status: 409,
			json: { code: "STALE_WRITE", currentContent: "tool\n" },
		});
		expect(await readFile(path, "utf8")).toBe("tool\n");
		expect(operations()).toHaveLength(1);
		expect(operations()[0].sourceKind).toBe("tool");
	});

	test("two real HTTP saves from one baseline serialize to one success and one conflict", async () => {
		const path = join(workspace, "two-saves.txt");
		await writeFile(path, "before\n");
		const responses = await Promise.all(
			["first\n", "second\n"].map((content) => save({ path, content, baseHash: hash("before\n") })),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		const current = await readFile(path, "utf8");
		expect(["first\n", "second\n"]).toContain(current);
		expect(responses.find((response) => response.status === 409)?.json.currentContent).toBe(
			current,
		);
		expect(applyCalls).toBe(1);
		expect(projections()).toHaveLength(1);
	});

	test("symlink retarget after preparation writes neither authorized nor replacement referent", async () => {
		const path = join(workspace, "link.txt");
		const original = join(workspace, "original.txt");
		const replacement = join(workspace, "replacement.txt");
		await writeFile(original, "old");
		await writeFile(replacement, "other");
		await symlink(original, path);
		const finalize = runtime.evidence.finalizePreparation.bind(runtime.evidence);
		const spy = spyOn(runtime.evidence, "finalizePreparation").mockImplementation(
			async (...args) => {
				const result = await finalize(...args);
				await rm(path);
				await symlink(replacement, path);
				return result;
			},
		);
		restorers.push(() => spy.mockRestore());
		expect((await save({ path, content: "human", baseHash: hash("old") })).status).toBe(403);
		expect(await readFile(original, "utf8")).toBe("old");
		expect(await readFile(replacement, "utf8")).toBe("other");
		expect(effects()[0].executionReceiptJson?.outcome).toBe("not_applied");
	});

	test("owner access revoked after raw read cannot leak conflict content or dispatch", async () => {
		const path = join(workspace, "private.txt");
		await writeFile(path, "private before");
		io.read = async (...args) => {
			const result = await fileChangeLocalIo.read(...args);
			db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, narratorId)).run();
			return result;
		};
		const response = await save({ path, content: "new", baseHash: hash("stale") });
		expect(response.status).toBe(404);
		expect(response.json.currentContent).toBeUndefined();
		expect(applyCalls).toBe(0);
		expect(operations()).toHaveLength(0);
	});

	test("project grant revoked after durable intent prevents dispatch", async () => {
		const projectId = generateId();
		const owner = generateId();
		const grant = generateId();
		const now = new Date().toISOString();
		db.insert(users)
			.values({ id: owner, username: owner, passwordHash: "x", createdAt: now })
			.run();
		db.insert(projects)
			.values({
				id: projectId,
				name: "Private project",
				gitPath: workspace,
				ownerUserId: owner,
				visibility: "private",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(aclGrants)
			.values({
				id: grant,
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId: userId,
				capability: "write",
				createdAt: now,
			})
			.run();
		db.update(narrators)
			.set({ contextProjectId: projectId, ownerUserId: owner, writeAudience: "project" })
			.where(eq(narrators.id, narratorId))
			.run();
		const path = join(workspace, "project.txt");
		await writeFile(path, "old");
		const finalize = runtime.evidence.finalizePreparation.bind(runtime.evidence);
		const spy = spyOn(runtime.evidence, "finalizePreparation").mockImplementation(
			async (...args) => {
				const result = await finalize(...args);
				db.delete(aclGrants).where(eq(aclGrants.id, grant)).run();
				return result;
			},
		);
		restorers.push(() => spy.mockRestore());
		expect((await save({ path, content: "new", baseHash: hash("old") })).status).toBe(404);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(operations()[0]?.projectId).toBe(projectId);
		expect(effects()[0].executionReceiptJson?.outcome).toBe("not_applied");
	});

	test("extra root permission revoked before dispatch cannot reuse the earlier boundary", async () => {
		const outside = await mkdtemp(join(testEnvironment.isolatedHome, "editor-revoked-extra-"));
		try {
			settings.paths.extraWritableDirs = [outside];
			const path = join(outside, "extra.txt");
			await writeFile(path, "old");
			const finalize = runtime.evidence.finalizePreparation.bind(runtime.evidence);
			const spy = spyOn(runtime.evidence, "finalizePreparation").mockImplementation(
				async (...args) => {
					const result = await finalize(...args);
					settings.paths.extraWritableDirs = [];
					return result;
				},
			);
			restorers.push(() => spy.mockRestore());
			expect((await save({ path, content: "new", baseHash: hash("old") })).status).toBe(403);
			expect(await readFile(path, "utf8")).toBe("old");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("editor evidence failures and immutable human projection", () => {
	test("before blob publication failure prevents any target IO", async () => {
		const path = join(workspace, "before-failure.txt");
		await writeFile(path, "old");
		const { store } = await runtime.initialize();
		const spy = spyOn(store, "putBytes").mockRejectedValue(
			new Error("injected before publication"),
		);
		restorers.push(() => spy.mockRestore());
		expect((await save({ path, content: "new", baseHash: hash("old") })).status).toBe(500);
		expect(applyCalls).toBe(0);
		expect(operations()).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe("old");
	});

	test("real quota admission refusal prevents any target IO", async () => {
		const path = join(workspace, "quota.txt");
		await writeFile(path, `before-${narratorId}`);
		const { catalog } = await runtime.initialize();
		const budget = catalog.getBudget();
		if (!budget) throw new Error("No budget");
		db.update(fileChangeStorageBudgets)
			.set({ quotaBytes: 0 })
			.where(eq(fileChangeStorageBudgets.id, budget.id))
			.run();
		try {
			expect(
				(await save({ path, content: "new", baseHash: hash(`before-${narratorId}`) })).status,
			).toBe(500);
			expect(applyCalls).toBe(0);
			expect(await readFile(path, "utf8")).toBe(`before-${narratorId}`);
		} finally {
			db.update(fileChangeStorageBudgets)
				.set({ quotaBytes: budget.quotaBytes })
				.where(eq(fileChangeStorageBudgets.id, budget.id))
				.run();
		}
	});

	test("effect preparation DB failure leaves target bytes untouched", async () => {
		const path = join(workspace, "prepare-db.txt");
		await writeFile(path, "old");
		failSql(
			"file_change_effects",
			"INSERT",
			`NEW.operation_id IN (SELECT id FROM file_change_operations WHERE owner_user_id = '${userId}')`,
		);
		expect((await save({ path, content: "new", baseHash: hash("old") })).status).toBe(500);
		expect(applyCalls).toBe(0);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(effects()).toHaveLength(0);
	});

	test("after-settlement DB failure retains intent, pending scope and no blind retry", async () => {
		const path = join(workspace, "settle-db.txt");
		await writeFile(path, "old");
		failSql(
			"file_change_effects",
			"UPDATE",
			`NEW.execution_receipt_json IS NOT NULL AND NEW.operation_id IN (SELECT id FROM file_change_operations WHERE owner_user_id = '${userId}')`,
		);
		const response = await save({ path, content: "written", baseHash: hash("old") });
		expect(response).toMatchObject({ status: 500, json: { code: "WRITE_RECONCILE_REQUIRED" } });
		expect(await readFile(path, "utf8")).toBe("written");
		expect(operations()[0]).toMatchObject({
			sourceKind: "editor",
			actorJson: { kind: "human", userId, narratorId: null },
		});
		expect(effects()[0]).toMatchObject({ settlement: "applying", executionReceiptJson: null });
		expect(await bytes(effects()[0].intendedAfterStateJson)).toEqual(Buffer.from("written"));
		expect(scope().status).toBe("needs_verification");
		expect((await save({ path, content: "written", baseHash: hash("written") })).status).toBe(500);
		expect(applyCalls).toBe(1);
	});

	test("operation-finish DB failure keeps the settled receipt frozen and blocks a new save", async () => {
		const path = join(workspace, "finish-db.txt");
		await writeFile(path, "old\n");
		failSql(
			"file_change_operations",
			"UPDATE",
			`NEW.execution_outcome = 'succeeded' AND NEW.owner_user_id = '${userId}'`,
		);
		expect(await save({ path, content: "written\n", baseHash: hash("old\n") })).toMatchObject({
			status: 500,
			json: { code: "WRITE_RECONCILE_REQUIRED" },
		});
		const frozen = effects()[0];
		expect(frozen).toMatchObject({
			settlement: "settled",
			attributionGrade: "measured",
			linesAdded: 1,
			linesRemoved: 1,
		});
		expect(operations()[0].settlement).not.toBe("settled");
		expect(scope().status).toBe("needs_verification");
		expect((await save({ path, content: "retry\n", baseHash: hash("written\n") })).status).toBe(
			500,
		);
		expect(effects()[0]).toEqual(frozen);
		expect(applyCalls).toBe(1);
		expect(await readFile(path, "utf8")).toBe("written\n");
	});

	test("projection DB failure is best-effort and cannot undo a successful receipt", async () => {
		const path = join(workspace, "projection-db.txt");
		failSql("file_attributions", "INSERT", `NEW.user_id = '${userId}'`);
		expect((await save({ path, content: "saved\n" })).status).toBe(200);
		expect(await readFile(path, "utf8")).toBe("saved\n");
		expect(operations()[0].settlement).toBe("settled");
		expect(effects()[0]).toMatchObject({ settlement: "settled", linesAdded: 1, linesRemoved: 0 });
		expect(projections()).toHaveLength(0);
	});

	test("post-write drift is quarantined, preserves foreign bytes and projects human unknown once", async () => {
		const path = join(workspace, "after-drift.txt");
		await writeFile(path, "old");
		const apply = io.apply;
		io.apply = async (input) => {
			await apply(input);
			await writeFile(path, "foreign after");
		};
		expect(await save({ path, content: "human", baseHash: hash("old") })).toMatchObject({
			status: 500,
			json: { code: "WRITE_RECONCILE_REQUIRED" },
		});
		expect(await readFile(path, "utf8")).toBe("foreign after");
		expect(effects()[0]).toMatchObject({
			settlement: "reconcile_required",
			linesAdded: null,
			linesRemoved: null,
		});
		expect(projections()).toHaveLength(1);
		expect(projections()[0]).toMatchObject({
			action: "human",
			narratorId: null,
			userId,
			linesAdded: null,
			linesRemoved: null,
		});
		expect(scope().status).toBe("needs_verification");
	});

	test("late metadata activity does not downgrade the frozen human grade/counts", async () => {
		const path = join(workspace, "frozen.txt");
		await writeFile(path, "one\n");
		const settle = runtime.evidence.settleEffect.bind(runtime.evidence);
		const spy = spyOn(runtime.evidence, "settleEffect").mockImplementation((input) => {
			const result = settle(input);
			const binding = localFileChangeRuntimeBinding();
			if (!binding) throw new Error("No runtime");
			const activity = runtime.coordinator.registerActivity({ scope: scope(), runtime: binding });
			runtime.coordinator.endActivity(activity);
			return result;
		});
		restorers.push(() => spy.mockRestore());
		expect((await save({ path, content: "two\n", baseHash: hash("one\n") })).status).toBe(200);
		expect(effects()[0]).toMatchObject({
			attributionGrade: "measured",
			linesAdded: 1,
			linesRemoved: 1,
		});
		expect(projections()[0]).toMatchObject({
			attributionGrade: "measured",
			linesAdded: 1,
			linesRemoved: 1,
			narratorId: null,
		});
	});

	test("real editor request id is single-attempt, never duplicate projection or linecounts", async () => {
		const path = join(workspace, "single-attempt.txt");
		let request: Parameters<LocalFileChangeRuntime["executeEditor"]>[0] | undefined;
		const original = runtime.executeEditor.bind(runtime);
		const spy = spyOn(runtime, "executeEditor").mockImplementation((input) => {
			request = input;
			return original(input);
		});
		restorers.push(() => spy.mockRestore());
		expect((await save({ path, content: "first\n" })).status).toBe(200);
		if (!request) throw new Error("No real request captured");
		const replay = request;
		await expect(
			withLocalFileChangeRuntime(runtime, () => executeEditorFileChange(replay)),
		).rejects.toThrow("no mutation was retried");
		expect(operations()).toHaveLength(1);
		expect(effects()).toHaveLength(1);
		expect(projections()).toHaveLength(1);
		expect(applyCalls).toBe(1);
	});

	test("tree capture and notification failures cannot turn a settled save into a failure", async () => {
		settings.chapters.treeSnapshotsEnabled = true;
		const invalidate = spyOn(sessionState, "invalidateWorkspaceTreeCache");
		const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot").mockRejectedValue(
			new Error("injected tree fault"),
		);
		const notify = spyOn(fileEditInterject, "interjectFileEditAsUserMessage").mockRejectedValue(
			new Error("injected notify fault"),
		);
		restorers.push(
			() => invalidate.mockRestore(),
			() => capture.mockRestore(),
			() => notify.mockRestore(),
		);
		const path = join(workspace, "best-effort.txt");
		expect((await save({ path, content: "saved\n", notifyAgent: true })).status).toBe(200);
		expect(invalidate).toHaveBeenCalledWith(workspace);
		expect(capture).toHaveBeenCalledWith(workspace, "local");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(await readFile(path, "utf8")).toBe("saved\n");
		expect(operations()[0].settlement).toBe("settled");
	});
});
