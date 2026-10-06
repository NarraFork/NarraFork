import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import iconv from "iconv-lite";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { fileChangeIdentityKey } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "./file-change-runtime";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import { type RevertPlanFileCursor, RevertPlanService } from "./revert-plan-service";
import {
	type RevertPlannerAccess,
	type RevertPlannerOptions,
	type RevertPlannerRequest,
	RevertPlannerService,
} from "./revert-planner-service";
import type { RevertSelectionResult } from "./revert-selection-service";
import type { ValidatedTransactionManifest } from "./revert-transaction-manifest-worker";
import { runRevertManifestWorker } from "./revert-transaction-worker";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

const principal: NarratorPrincipal = { userId: "alice", isAdmin: false };
let root: string;
let workspace: string;
let sqlite: Database;
let db: ReturnType<typeof database>;
function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}
let runtime: LocalFileChangeRuntime;
let service: RevertPlannerService;
let plans: RevertPlanService;
let namespace: Awaited<ReturnType<LocalFileChangeRuntime["initialize"]>>;
let options: RevertPlannerOptions;
let serial: number;
let reads: number;
let narratorAuthorizations: number;
let authentications: number;
let allowedFiles: Set<string>;
let beforeRead: ((path: string, count: number) => void | Promise<void>) | undefined;
let beforeNarratorAuthorization: ((count: number) => void) | undefined;
let beforeAuthentication: ((count: number) => void) | undefined;
let clock: number;
const now = () => new Date(clock).toISOString();
const owner = { subjectKey: "human:alice", narratorId: "root", projectId: "project" };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	root = await mkdtemp(join(await realpath(tmpdir()), "revert-planner-test-"));
	workspace = join(root, "workspace");
	await mkdir(workspace);
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
	// Schema ONLY from the test-preload-isolated DB. No production connection/data,
	// migration edits, fake receipts or mocked selection/reversal/planner services.
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	for (const definition of definitions) sqlite.exec(definition.sql);
	db = database(sqlite);
	clock = Date.parse("2026-09-07T12:00:00.000Z");
	serial = 0;
	reads = 0;
	narratorAuthorizations = 0;
	authentications = 0;
	allowedFiles = new Set();
	beforeRead = undefined;
	beforeNarratorAuthorization = undefined;
	beforeAuthentication = undefined;
	for (const id of ["alice", "bob"])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "test-not-a-credential", createdAt: now() })
			.run();
	db.insert(schema.projects)
		.values({
			id: "project",
			name: "Isolated project",
			ownerUserId: "alice",
			gitPath: workspace,
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	for (const id of ["root", "fork"])
		db.insert(schema.narrators)
			.values({
				id,
				title: id,
				ownerUserId: "alice",
				contextProjectId: "project",
				messageVersion: 7,
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
	runtime = new LocalFileChangeRuntime({
		db,
		privateRoot: join(root, "private"),
		coordinatorState: createWorkspaceWriteCoordinatorState(),
		blobStoreOptions: { minimumFreeBytes: 0 },
	});
	namespace = await runtime.initialize();
	const access: RevertPlannerAccess = {
		async authenticate(user, signal) {
			signal.throwIfAborted();
			authentications++;
			beforeAuthentication?.(authentications);
			const row = db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get();
			if (!row || user.isAdmin !== (row.role === "admin")) throw new Error("Authentication denied");
		},
		async authorizeNarrator(user, row, need, signal) {
			signal.throwIfAborted();
			expect(need).toBe("write");
			narratorAuthorizations++;
			beforeNarratorAuthorization?.(narratorAuthorizations);
			checkNarrator(user, row);
		},
		async resolveContext({ principal: user, narratorId, signal }) {
			signal.throwIfAborted();
			const narrator = db
				.select()
				.from(schema.narrators)
				.where(eq(schema.narrators.id, narratorId))
				.get();
			if (!narrator) throw new Error("Narrator not found");
			checkNarrator(user, narrator);
			if (narrator.chapterId) throw new Error("Fixture has no chapter capability");
			if (!narrator.contextProjectId) return { projectId: null };
			const project = db
				.select()
				.from(schema.projects)
				.where(eq(schema.projects.id, narrator.contextProjectId))
				.get();
			if (!project || (!user.isAdmin && project.ownerUserId !== user.userId))
				throw new Error("Project ACL denied");
			return { projectId: project.id };
		},
		async authorizeFile({ principal: user, owner: context, identity, signal }) {
			signal.throwIfAborted();
			if (
				user.userId !== "alice" ||
				context.projectId !== "project" ||
				!allowedFiles.has(identity.canonicalPath)
			)
				throw new Error("File ACL denied");
		},
		async resolveFile({ identity, signal }) {
			signal.throwIfAborted();
			// Explicit local capability. A remote identity MUST NOT consult a local path,
			// even if its display/canonical string happens to equal an existing file here.
			if (identity.deviceId !== "local") throw new Error("Remote capability unavailable");
			const scope = db
				.select()
				.from(schema.fileChangeScopes)
				.where(eq(schema.fileChangeScopes.id, identity.scopeId))
				.get();
			const binding = localFileChangeRuntimeBinding(identity.deviceId);
			if (!scope || !binding) throw new Error("Scope/runtime missing");
			const executionBinding = {
				deviceId: "local",
				runtimeEpoch: binding.runtimeEpoch,
				runtimeGeneration: binding.runtimeGeneration,
				fencingToken: scope.fencingToken,
			};
			return {
				identity,
				executionBinding,
				scopeRevision: scope.revision,
				async assertCurrent({ signal: currentSignal }) {
					currentSignal.throwIfAborted();
					const live = db
						.select()
						.from(schema.fileChangeScopes)
						.where(eq(schema.fileChangeScopes.id, scope.id))
						.get();
					const runtimeBinding = localFileChangeRuntimeBinding("local");
					if (
						!live ||
						live.status !== "active" ||
						live.activeMutationCount !== 0 ||
						live.activeLeaseId ||
						live.revision !== scope.revision ||
						live.fencingToken !== scope.fencingToken ||
						live.sourceInstanceId !== identity.sourceInstanceId ||
						live.workspaceInstanceId !== identity.workspaceInstanceId ||
						live.deviceId !== identity.deviceId ||
						live.pathFlavor !== identity.pathFlavor ||
						runtimeBinding?.runtimeEpoch !== executionBinding.runtimeEpoch ||
						runtimeBinding?.runtimeGeneration !== executionBinding.runtimeGeneration
					)
						throw new Error("Scope/runtime drift");
					if ((await localDirectoryIdentity(scope.canonicalRoot)) !== live.rootIdentityJson?.object)
						throw new Error("Workspace incarnation changed");
					const resolved = await localBackend.resolvePathIdentity(identity.lexicalPath);
					if (resolved.canonicalPath !== identity.canonicalPath)
						throw new Error("Canonical target drift");
				},
				async readCurrent({ signal: readSignal, maxBytes }) {
					reads++;
					await beforeRead?.(identity.canonicalPath, reads);
					const observed = await fileChangeLocalIo.read(identity.canonicalPath, readSignal);
					if (observed.bytes === null) return { state: { kind: "absent" }, raw: null };
					expect(observed.bytes.byteLength).toBeLessThanOrEqual(maxBytes);
					return {
						state: {
							kind: "regular",
							mode: observed.mode,
							blob: {
								algorithm: "sha256",
								digest: hash(observed.bytes),
								sizeBytes: observed.bytes.byteLength,
							},
						},
						raw: observed.bytes,
					};
				},
			};
		},
	};
	options = {
		access,
		blobStore: namespace.store,
		blobCatalog: namespace.catalog,
		generation: namespace.generation,
		planOptions: { namespaceKey: namespace.catalog.getBudget()?.namespaceKey ?? "missing", now },
		onSlow: () => {},
	};
	service = new RevertPlannerService(db, options);
	plans = new RevertPlanService(db, options.planOptions);
});
afterEach(async () => {
	sqlite.close();
	await rm(root, { recursive: true, force: true });
});
function checkNarrator(user: NarratorPrincipal, row: NarratorAclRow) {
	if (!user.isAdmin && row.ownerUserId !== user.userId) throw new Error("Narrator ACL denied");
}
function request(extra: Partial<RevertPlannerRequest> = {}): RevertPlannerRequest {
	return {
		principal,
		narratorId: "root",
		expectedMessageVersion: 7,
		idempotencyKey: "preview",
		kind: "revert",
		revertScope: "narrator",
		selector: { kind: "all" },
		...extra,
	};
}
async function context(
	name: "Write" | "Edit",
	path: string,
	input: Record<string, unknown>,
	providerId = generateId(),
) {
	allowedFiles.add(path);
	const resolved = await localBackend.resolvePathIdentity(path);
	const target: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd: workspace,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: resolved.lexicalPath,
		canonicalPath: resolved.canonicalPath,
		runtimeGeneration: 0,
		selectionSource: "local_default",
	};
	const messageId = generateId();
	const toolCallId = generateId();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId: "root",
			role: "assistant",
			contentJson: [
				{ type: "text", text: "retain" },
				{ type: "tool_use", id: providerId, name, input },
			],
			createdAt: now(),
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: "root", messageId, seq: ++serial })
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: "root",
			messageId,
			toolUseId: providerId,
			toolName: name,
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now(),
			executionDeviceId: "local",
			executionCwd: workspace,
			executionPathFlavor: localBackend.pathFlavor,
			resolvedFilePath: resolved.lexicalPath,
			canonicalFilePath: resolved.canonicalPath,
			runtimeGeneration: 0,
			createdAt: now(),
		})
		.run();
	const ctx: ToolContext = {
		narratorId: "root",
		cwd: workspace,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: providerId,
		toolCallBinding: { toolCallId, attempt: 1 },
		executionTarget: target,
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
	return { ctx, messageId, toolCallId, providerId };
}
async function write(path: string, content: string, providerId?: string) {
	const input = { file_path: path, content };
	const call = await context("Write", path, input, providerId);
	const result = await withLocalFileChangeRuntime(runtime, () =>
		writeTool.execute(input, call.ctx),
	);
	db.update(schema.narratorToolCalls)
		.set({ status: result.isError ? "fail" : "success" })
		.where(eq(schema.narratorToolCalls.id, call.toolCallId))
		.run();
	expect(result.isError, String(result.output)).not.toBe(true);
	return call;
}
async function edit(
	path: string,
	before: string,
	after: string,
	expectError = false,
	providerId?: string,
) {
	const input = { file_path: path, old_string: before, new_string: after };
	const call = await context("Edit", path, input, providerId);
	const result = await withLocalFileChangeRuntime(runtime, () => editTool.execute(input, call.ctx));
	db.update(schema.narratorToolCalls)
		.set({ status: result.isError ? "fail" : "success" })
		.where(eq(schema.narratorToolCalls.id, call.toolCallId))
		.run();
	if (expectError) expect(result.isError).toBe(true);
	else expect(result.isError, String(result.output)).not.toBe(true);
	return call;
}
function historySnapshot() {
	return JSON.stringify({
		messages: db.select().from(schema.narratorMessages).all(),
		refs: db.select().from(schema.narratorMessageRefs).all(),
		tools: db.select().from(schema.narratorToolCalls).all(),
	});
}
function assertUnprepared() {
	expect(
		db
			.select()
			.from(schema.revertOperations)
			.all()
			.filter((row) => row.status === "prepared" || row.coverageComplete),
	).toHaveLength(0);
}
async function bytes(state: FileChangeState) {
	if (state.kind !== "regular") throw new Error("Expected regular state");
	return Buffer.from(await namespace.store.readBytes(state.blob));
}
async function rawManifest<T>(digest: string | null) {
	if (!digest) throw new Error("Manifest ref missing");
	const row = db
		.select()
		.from(schema.fileChangeBlobs)
		.where(eq(schema.fileChangeBlobs.digest, digest))
		.get();
	if (!row) throw new Error("Published row missing");
	expect(row.status).toBe("ready");
	const raw = await namespace.store.readBytes({
		algorithm: "sha256",
		digest,
		sizeBytes: row.sizeBytes,
	});
	expect(hash(raw)).toBe(digest);
	return JSON.parse(Buffer.from(raw).toString()) as T;
}
async function fixture() {
	const path = join(workspace, "combined.txt");
	const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
	await writeFile(path, original);
	const first = await write(path, original.replace("A0", "A1"));
	await writeFile(path, (await readFile(path, "utf8")).replace("H0", "H1"));
	const second = await edit(path, "B0", "B1");
	await writeFile(path, (await readFile(path, "utf8")).replace("H1", "H2"));
	return { path, original, first, second };
}
async function prepare(extra: Partial<RevertPlannerRequest> = {}) {
	return service.prepare(request(extra));
}

// Await paged worker/yield work normally; Bun's async rejects matcher can starve
// these callbacks and let teardown close a database while a test is still running.
async function rejected(pending: Promise<unknown>) {
	const result = await pending.then(
		() => ({ rejected: false, error: undefined }),
		(error: unknown) => ({ rejected: true, error }),
	);
	expect(result.rejected).toBe(true);
	return {
		toMatchObject: (expected: object) => expect(result.error).toMatchObject(expected),
		toThrow: (expected?: string) =>
			expect(() => {
				throw result.error;
			}).toThrow(expected),
	};
}

describe("real tool evidence -> complete prepared preview", () => {
	test("Write A -> human -> Edit B -> late human preserves human raw bytes without workspace/history mutation", async () => {
		const { path, original } = await fixture();
		const disk = await readFile(path);
		const history = historySnapshot();
		const result = await prepare();
		expect(result.executable).toBe(false);
		expect(result.plan.status).toBe("prepared");
		expect(result.plan.coverageComplete).toBe(true);
		expect(result.plan.expectedFileCount).toBe(1);
		const file = plans.listFiles(owner, result.plan.id).items[0];
		expect(await bytes(file.expectedStateJson)).toEqual(disk);
		expect((await bytes(file.desiredStateJson)).toString()).toBe(original.replace("H0", "H2"));
		expect(await readFile(path)).toEqual(disk);
		expect(historySnapshot()).toBe(history);
		expect(reads).toBe(2);
		expect(narratorAuthorizations).toBe(9);
		expect(authentications).toBe(2);
		const selected = await rawManifest<RevertSelectionResult>(result.plan.manifestDigests.history);
		expect(selected.effects).toHaveLength(2);
		expect(selected.operations).toHaveLength(2);
		expect(selected.tools).toHaveLength(2);
		expect(selected.messageVersions).toEqual([{ narratorId: "root", messageVersion: 7 }]);
		const manifest = await rawManifest<{
			selectionMetadataDigest: string;
			files: { steps: { scopeRevision: number }[] }[];
		}>(result.plan.manifestDigests.plan);
		expect(manifest.selectionMetadataDigest).toBe(selected.metadataDigest);
		expect(manifest.files[0].steps.map((step) => step.scopeRevision)).toEqual(
			selected.effects.map((effect) => effect.scopeRevision).sort((a, b) => b - a),
		);
		await rawManifest(result.plan.manifestDigests.selector);
		// Original raw manifest pointers are FK-pinned, not a trimmed substitute.
		expect(() =>
			db
				.delete(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, result.plan.manifestDigests.plan ?? ""))
				.run(),
		).toThrow();
	});
	test("GBK and CRLF are restored as original bytes after current encoding settings change", async () => {
		const path = join(workspace, "legacy.txt");
		const original = iconv.encode("原始内容\r\n保留\r\n", "gbk");
		await writeFile(path, original);
		settings.agent.legacyEncoding = true;
		await write(path, "修改内容\n保留\n");
		settings.agent.legacyEncoding = false;
		const disk = await readFile(path);
		const before = historySnapshot();
		const result = await prepare();
		const file = plans.listFiles(owner, result.plan.id).items[0];
		expect((await bytes(file.desiredStateJson)).equals(original)).toBe(true);
		expect(await readFile(path)).toEqual(disk);
		expect(historySnapshot()).toBe(before);
	});
	test("COW duplicate provider IDs preserve PK-origin operation identity and a fixed partial boundary", async () => {
		const path = join(workspace, "cow.txt");
		await writeFile(path, "A0\n1\n2\n3\nB0\n");
		const first = await edit(path, "A0", "A1", false, "same-provider");
		await edit(path, "B0", "B1", false, "same-provider");
		const source = db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, first.toolCallId))
			.get();
		if (!source) throw new Error("Missing origin");
		const clone = await context(
			"Edit",
			path,
			{ old_string: "A0", new_string: "A1" },
			"same-provider",
		);
		db.update(schema.narratorToolCalls)
			.set({
				status: "success",
				executionOriginToolCallId: source.id,
				fileChangeOperationId: source.fileChangeOperationId,
			})
			.where(eq(schema.narratorToolCalls.id, clone.toolCallId))
			.run();
		db.insert(schema.narratorMessageRefs)
			.values({ id: generateId(), narratorId: "fork", messageId: first.messageId, seq: 1 })
			.run();
		const before = historySnapshot();
		const disk = await readFile(path);
		const result = await prepare({
			kind: "rollback_to_block",
			selector: { kind: "after_block", messageId: first.messageId, keepThroughBlockIndex: 0 },
		});
		const selected = await rawManifest<RevertSelectionResult>(result.plan.manifestDigests.history);
		expect(selected.history.messages[0].action).toBe("copy_on_write");
		expect(selected.tools).toHaveLength(3);
		expect(selected.effects).toHaveLength(2);
		expect(selected.operations).toHaveLength(2);
		expect(selected.boundary?.retainedThroughKey).toBeTruthy();
		expect(await readFile(path)).toEqual(disk);
		expect(historySnapshot()).toBe(before);
	});
	test("a real validation no_dispatch has exactly zero effects and remains in full history manifest", async () => {
		const path = join(workspace, "no-dispatch.txt");
		await writeFile(path, "original");
		await edit(path, "not found", "replacement", true);
		expect(db.select().from(schema.fileChangeEffects).all()).toHaveLength(0);
		const before = historySnapshot();
		const result = await prepare({ kind: "history_delete" });
		expect(result.plan.expectedFileCount).toBe(0);
		expect(reads).toBe(0);
		const selected = await rawManifest<RevertSelectionResult>(result.plan.manifestDigests.history);
		expect(selected.noDiskTools).toHaveLength(1);
		expect(selected.noDiskTools[0].reason).toBe("no_dispatch");
		expect(selected.operations).toHaveLength(1);
		expect(selected.effects).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe("original");
		expect(historySnapshot()).toBe(before);
	});
	test("all targets remain pageable across plan batch boundaries", async () => {
		for (let i = 0; i < 34; i++) {
			const path = join(workspace, `${i}.txt`);
			await writeFile(path, `original ${i}`);
			await write(path, `changed ${i}`);
		}
		const before = historySnapshot();
		const result = await prepare();
		let cursor: RevertPlanFileCursor | undefined;
		const sequences: number[] = [];
		for (;;) {
			const page = plans.listFiles(owner, result.plan.id, { limit: 7, cursor });
			for (const file of page.items) {
				sequences.push(file.sequence);
				expect((await bytes(file.desiredStateJson)).toString()).toStartWith("original");
				expect(await readFile(file.identityJson.canonicalPath, "utf8")).toStartWith("changed");
			}
			if (!page.hasMore) break;
			cursor = page.nextCursor ?? undefined;
		}
		expect(sequences.sort((a, b) => a - b)).toEqual(Array.from({ length: 34 }, (_, i) => i));
		expect(historySnapshot()).toBe(before);
	}, 30_000);
});

describe("no partial executable prefix", () => {
	test("unmeasured mode and unknown current states cannot pass through a matching raw hash", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		const resolve = options.access.resolveFile;
		options.access.resolveFile = async (input) => {
			const target = await resolve(input);
			return {
				...target,
				async readCurrent(readOptions) {
					const actual = await target.readCurrent(readOptions);
					return {
						...actual,
						state: actual.state.kind === "regular" ? { ...actual.state, mode: null } : actual.state,
					};
				},
			};
		};
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_STATE_UNKNOWN" });
		options.access.resolveFile = async (input) => {
			const target = await resolve(input);
			return {
				...target,
				async readCurrent(readOptions) {
					await target.readCurrent(readOptions);
					return { state: { kind: "unknown", reason: "unreadable" }, raw: null };
				},
			};
		};
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_STATE_UNKNOWN" });
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("unmeasured historical mode cannot become a desired restore state", async () => {
		const path = join(workspace, "unknown-historical-mode.txt");
		await writeFile(path, "old");
		await write(path, "new");
		const effect = db.select().from(schema.fileChangeEffects).get();
		if (!effect || effect.beforeStateJson.kind !== "regular")
			throw new Error("Missing actual state");
		db.update(schema.fileChangeEffects)
			.set({ beforeStateJson: { ...effect.beforeStateJson, mode: null } })
			.where(eq(schema.fileChangeEffects.id, effect.id))
			.run();
		const before = historySnapshot();
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_STATE_UNKNOWN" });
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new");
	});
	test("a no_dispatch label with nonzero persisted effects is not a zero-change shortcut", async () => {
		const { path } = await fixture();
		const operation = db.select().from(schema.fileChangeOperations).get();
		if (!operation) throw new Error("Missing real operation");
		db.update(schema.fileChangeOperations)
			.set({
				expectedEffectCount: 0,
				preparedEffectCount: 0,
				settledEffectCount: 0,
				evidenceBytes: 0,
				effectOutcome: "no_change",
				executionOutcome: "failed",
				reason: "no_dispatch:validation_rejected",
			})
			.where(eq(schema.fileChangeOperations.id, operation.id))
			.run();
		const before = historySnapshot();
		const disk = await readFile(path);
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_EVIDENCE_INCOMPLETE" });
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("missing journal for any selected write candidate refuses the entire preview", async () => {
		const { path } = await fixture();
		const missing = await context("Write", path, { content: "unmeasured" });
		db.update(schema.narratorToolCalls)
			.set({ status: "success" })
			.where(eq(schema.narratorToolCalls.id, missing.toolCallId))
			.run();
		const before = historySnapshot();
		const disk = await readFile(path);
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_EVIDENCE_INCOMPLETE" });
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("unknown receipt/outcome stays a rejected candidate rather than being filtered out", async () => {
		const { path } = await fixture();
		const effect = db.select().from(schema.fileChangeEffects).get();
		if (!effect) throw new Error("Missing effect");
		db.update(schema.fileChangeEffects)
			.set({ outcome: "unknown", settlement: "reconcile_required", executionConfirmed: false })
			.where(eq(schema.fileChangeEffects.id, effect.id))
			.run();
		const before = historySnapshot();
		const disk = await readFile(path);
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_EVIDENCE_INCOMPLETE" });
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("one overlapping conflict refuses otherwise reversible files without persisting a prefix", async () => {
		const first = join(workspace, "safe.txt");
		const second = join(workspace, "conflict.txt");
		await writeFile(first, "old");
		await write(first, "new");
		await writeFile(second, "old");
		await write(second, "new");
		await writeFile(second, "human overwrite");
		const before = historySnapshot();
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_REVERSAL_REFUSED" });
		assertUnprepared();
		expect(db.select().from(schema.revertOperationFiles).all()).toHaveLength(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(first, "utf8")).toBe("new");
		expect(await readFile(second, "utf8")).toBe("human overwrite");
	});
	test("catalog-ready but missing physical evidence is not accepted as a restore shortcut", async () => {
		const { path } = await fixture();
		const effect = db.select().from(schema.fileChangeEffects).get();
		if (!effect?.beforeBlobDigest) throw new Error("Missing actual raw fixture");
		const row = db
			.select()
			.from(schema.fileChangeBlobs)
			.where(eq(schema.fileChangeBlobs.digest, effect.beforeBlobDigest))
			.get();
		if (!row) throw new Error("Missing blob");
		await unlink(join(root, "private", "file-change-blobs", row.storageKey));
		const before = historySnapshot();
		const disk = await readFile(path);
		(await rejected(prepare())).toThrow();
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("remote identity with the same path does not resolve through a local capability", async () => {
		const path = join(workspace, "same-path.txt");
		await writeFile(path, "old");
		await write(path, "new");
		// Corrupt neither the real local evidence nor the workspace. Add an imported,
		// separately device-bound measured metadata candidate using the real raw refs.
		const effect = db.select().from(schema.fileChangeEffects).get();
		const operation = db.select().from(schema.fileChangeOperations).get();
		const scope = db.select().from(schema.fileChangeScopes).get();
		if (!effect || !operation || !scope || !effect.executionReceiptJson)
			throw new Error("Missing source fixture");
		const remoteScopeId = generateId();
		const remoteOperationId = generateId();
		const call = await context("Write", path, { content: "remote" });
		const identity = {
			...effect.identityJson,
			scopeId: remoteScopeId,
			deviceId: "remote",
			workspaceInstanceId: "remote-workspace",
		};
		const binding = { ...effect.executionReceiptJson.executionBinding, deviceId: "remote" };
		db.insert(schema.fileChangeScopes)
			.values({
				...scope,
				id: remoteScopeId,
				deviceId: "remote",
				workspaceInstanceId: identity.workspaceInstanceId,
			})
			.run();
		db.insert(schema.fileChangeOperations)
			.values({
				...operation,
				id: remoteOperationId,
				sourceId: call.toolCallId,
				toolCallId: call.toolCallId,
				executionBindingJson: binding,
			})
			.run();
		db.insert(schema.fileChangeEffects)
			.values({
				...effect,
				id: generateId(),
				operationId: remoteOperationId,
				scopeId: remoteScopeId,
				fileKey: fileChangeIdentityKey(identity),
				identityJson: identity,
				mutationId: "remote-mutation",
				executionReceiptJson: {
					...effect.executionReceiptJson,
					mutationId: "remote-mutation",
					executionBinding: binding,
				},
			})
			.run();
		db.update(schema.narratorToolCalls)
			.set({
				status: "success",
				executionDeviceId: "remote",
				fileChangeOperationId: remoteOperationId,
			})
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.run();
		const before = historySnapshot();
		(await rejected(prepare())).toThrow("Remote capability unavailable");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new");
	});
});

describe("mandatory authorization, freshness and idempotency", () => {
	test("missing authorization adapter is rejected at construction", () => {
		expect(
			() => new RevertPlannerService(db, { ...options, access: {} as RevertPlannerAccess }),
		).toThrow("Real authentication");
	});
	test("authenticated subject labels alone cannot authorize another user", async () => {
		await fixture();
		const before = historySnapshot();
		(await rejected(prepare({ principal: { userId: "bob", isAdmin: false } }))).toThrow(
			"Narrator ACL denied",
		);
		(await rejected(prepare({ principal: { userId: "alice", isAdmin: true } }))).toThrow(
			"Authentication denied",
		);
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
	});
	test("project write gate and file permission must both hold", async () => {
		const { path } = await fixture();
		db.update(schema.projects)
			.set({ ownerUserId: "bob" })
			.where(eq(schema.projects.id, "project"))
			.run();
		(await rejected(prepare())).toThrow("Project ACL denied");
		db.update(schema.projects)
			.set({ ownerUserId: "alice" })
			.where(eq(schema.projects.id, "project"))
			.run();
		allowedFiles.delete(path);
		const before = historySnapshot();
		(await rejected(prepare())).toThrow("File ACL denied");
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
	});
	test("ACL revoked before the second collector is rechecked before any plan write", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		beforeNarratorAuthorization = (count) => {
			if (count >= 3) throw new Error("Narrator grant revoked");
		};
		(await rejected(prepare())).toThrow("Narrator grant revoked");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("file ACL revoked after computation is checked again", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		beforeAuthentication = (count) => {
			if (count === 2) allowedFiles.delete(path);
		};
		(await rejected(prepare())).toThrow("File ACL denied");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
	});
	test("unrelated database writes during selection and final file checks do not veto preview", async () => {
		const { path } = await fixture();
		const disk = await readFile(path);
		beforeNarratorAuthorization = (count) => {
			db.update(schema.users)
				.set({ username: `unrelated-${count}` })
				.where(eq(schema.users.id, "bob"))
				.run();
		};
		beforeRead = (_path, count) => {
			db.update(schema.users)
				.set({ username: `unrelated-file-check-${count}` })
				.where(eq(schema.users.id, "bob"))
				.run();
		};
		const result = await prepare();
		expect(result.plan.status).toBe("prepared");
		expect(result.plan.coverageComplete).toBe(true);
		expect(await readFile(path)).toEqual(disk);
	});

	test("original expected message version is enforced", async () => {
		await fixture();
		const before = historySnapshot();
		(await rejected(prepare({ expectedMessageVersion: 6 }))).toMatchObject({
			code: "REVERT_SELECTION_STALE",
		});
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
	});
	test("message body drift without a version bump invalidates the metadata digest", async () => {
		const { path, first } = await fixture();
		const disk = await readFile(path);
		let altered: string | undefined;
		beforeRead = (_path, count) => {
			if (count === 1) {
				const row = db
					.select()
					.from(schema.narratorMessages)
					.where(eq(schema.narratorMessages.id, first.messageId))
					.get();
				if (!row || !Array.isArray(row.contentJson)) throw new Error("Missing message");
				db.update(schema.narratorMessages)
					.set({
						contentJson: [
							{ type: "text", text: "external message change" },
							...row.contentJson.slice(1),
						],
					})
					.where(eq(schema.narratorMessages.id, first.messageId))
					.run();
				altered = historySnapshot();
			}
		};
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_STALE" });
		assertUnprepared();
		expect(altered).toBeDefined();
		expect(historySnapshot()).toBe(altered ?? "missing alteration");
		expect(await readFile(path)).toEqual(disk);
	});
	test("current bytes drift during final check refuses rather than silently recomputing", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		beforeRead = async (_path, count) => {
			if (count === 2) await writeFile(path, "later human contents");
		};
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_STALE" });
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("later human contents");
	});
	test("scope/runtime revalidation cannot be replaced by matching bytes", async () => {
		await fixture();
		const before = historySnapshot();
		beforeAuthentication = (count) => {
			if (count === 2)
				db.update(schema.fileChangeScopes).set({ status: "needs_verification" }).run();
		};
		(await rejected(prepare())).toThrow("Scope/runtime drift");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
	});
	test("same complete request reuses its prepared ID; different raw selector order or kind conflicts", async () => {
		const { first, second } = await fixture();
		const selector = {
			kind: "tool_calls" as const,
			toolCallIds: [first.toolCallId, second.toolCallId],
		};
		const result = await prepare({ selector });
		expect((await prepare({ selector })).plan.id).toBe(result.plan.id);
		(
			await rejected(
				prepare({ selector: { ...selector, toolCallIds: [second.toolCallId, first.toolCallId] } }),
			)
		).toMatchObject({ code: "REVERT_PLANNER_REQUEST_CONFLICT" });
		(await rejected(prepare({ selector, kind: "history_delete" }))).toMatchObject({
			code: "REVERT_PLANNER_REQUEST_CONFLICT",
		});
		expect(db.select().from(schema.revertOperations).all()).toHaveLength(1);
	});
	test("expired same-key previews explicitly require a new request key", async () => {
		await fixture();
		await prepare();
		const before = historySnapshot();
		clock += FILE_CHANGE_LIMITS.planLifetimeMs + 1;
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_EXPIRED" });
		expect(historySnapshot()).toBe(before);
	});
	test("workspace/unrevert/unknown proof fields cannot bypass completeness", async () => {
		await fixture();
		const before = historySnapshot();
		(await rejected(prepare({ kind: "unrevert" as "revert" }))).toMatchObject({
			code: "REVERT_PLANNER_UNSUPPORTED",
		});
		(await rejected(prepare({ revertScope: "workspace" as "narrator" }))).toMatchObject({
			code: "REVERT_PLANNER_UNSUPPORTED",
		});
		(
			await rejected(
				service.prepare({
					...request(),
					manifestProof: { computation: "complete" },
				} as RevertPlannerRequest),
			)
		).toMatchObject({ code: "REVERT_PLANNER_INVALID_INPUT" });
		assertUnprepared();
		expect(reads).toBe(0);
		expect(historySnapshot()).toBe(before);
	});
});

describe("aggregate budgets, cancellation and storage failures", () => {
	test("the global 256MiB hard ceiling cannot be raised by configuration", () => {
		expect(
			() =>
				new RevertPlannerService(db, {
					...options,
					maxEvidenceBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes + 1,
				}),
		).toThrow("Value exceeds");
	});
	test("cancelled uncooperative adapters retain admission until their actual work settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const authenticate = options.access.authenticate;
		options.access.authenticate = async (...args) => {
			await gate;
			await authenticate(...args);
		};
		service = new RevertPlannerService(db, { ...options, timeoutMs: 1000 });
		const first = new AbortController();
		const second = new AbortController();
		const one = prepare({ signal: first.signal }).catch((error: unknown) => error);
		const two = prepare({ signal: second.signal }).catch((error: unknown) => error);
		try {
			(await rejected(prepare({ idempotencyKey: "third" }))).toMatchObject({
				code: "REVERT_PLANNER_BUSY",
			});
			first.abort(new Error("cancelled first"));
			second.abort(new Error("cancelled second"));
			expect(await one).toMatchObject({ message: "cancelled first" });
			expect(await two).toMatchObject({ message: "cancelled second" });
			(await rejected(prepare({ idempotencyKey: "still busy" }))).toMatchObject({
				code: "REVERT_PLANNER_BUSY",
			});
		} finally {
			release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			options.access.authenticate = authenticate;
		}
		expect((await prepare({ idempotencyKey: "recovered" })).plan.status).toBe("prepared");
	});
	test("actual manifest streaming publication observes cancellation and never pins a plan", async () => {
		const path = join(workspace, "publish.txt");
		await writeFile(path, "old");
		await write(path, "new");
		const before = historySnapshot();
		const controller = new AbortController();
		const putStream = namespace.store.putStream.bind(namespace.store);
		let cancelledPublication: ReturnType<typeof putStream> | undefined;
		let publications = 0;
		const publishing = spyOn(namespace.store, "putStream").mockImplementation((source, input) => {
			if (++publications !== 2) return putStream(source, input);
			if (!(Symbol.asyncIterator in source)) throw new Error("Expected actual manifest chunks");
			cancelledPublication = putStream(
				(async function* () {
					for await (const chunk of source) {
						yield chunk;
						controller.abort(new Error("cancel manifest stream"));
					}
				})(),
				input,
			);
			return cancelledPublication;
		});
		try {
			(await rejected(prepare({ signal: controller.signal }))).toThrow("cancel manifest stream");
		} finally {
			await cancelledPublication?.catch(() => {});
			publishing.mockRestore();
		}
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new");
	});
	test("blob catalog save failure does not manufacture ready manifests", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		sqlite.exec(
			"CREATE TRIGGER fail_blob BEFORE INSERT ON file_change_blobs BEGIN SELECT RAISE(ABORT,'forced blob catalog failure'); END",
		);
		(await rejected(prepare())).toThrow();
		assertUnprepared();
		expect(db.select().from(schema.revertOperations).all()).toHaveLength(0);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("all raw refs plus current/desired and original manifests share one cross-file cap", async () => {
		for (let i = 0; i < 2; i++) {
			const path = join(workspace, `${i}.txt`);
			await writeFile(path, "a".repeat(4096));
			await write(path, "b".repeat(4096));
		}
		const before = historySnapshot();
		service = new RevertPlannerService(db, { ...options, maxEvidenceBytes: 16 * 1024 });
		(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_BUDGET_EXCEEDED" });
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
	});
	test("cross-file and receipt aliases fit unique evidence capacity without duplicate raw charges", async () => {
		for (let i = 0; i < 2; i++) {
			const path = join(workspace, `${i}.txt`);
			await writeFile(path, "a".repeat(4096));
			await write(path, "b".repeat(4096));
		}
		// Historical declarations can overlap; neither planner nor final worker sums them.
		sqlite.query("UPDATE file_change_operations SET evidence_bytes=?").run(160 * 1024 * 1024);
		const fixedHistory = historySnapshot();
		service = new RevertPlannerService(db, { ...options, maxEvidenceBytes: 32 * 1024 });
		const plan = (await prepare()).plan;
		expect(plan.status).toBe("prepared");
		const operation = db
			.select()
			.from(schema.revertOperations)
			.where(eq(schema.revertOperations.id, plan.id))
			.get();
		if (!operation) throw new Error("Missing prepared plan");
		const raw = [];
		for (const digest of [
			operation.planBlobDigest,
			operation.selectorBlobDigest,
			operation.historyManifestBlobDigest,
		]) {
			const row = db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, digest ?? ""))
				.get();
			if (!row) throw new Error("Missing manifest");
			const ref = { algorithm: "sha256" as const, digest: row.digest, sizeBytes: row.sizeBytes };
			raw.push({ ref, bytes: await namespace.store.readBytes(ref) });
		}
		const validated = await runRevertManifestWorker<ValidatedTransactionManifest>(
			{
				action: "validate",
				raw,
				operation,
				userId: principal.userId,
				files: db
					.select()
					.from(schema.revertOperationFiles)
					.where(eq(schema.revertOperationFiles.revertOperationId, plan.id))
					.limit(3)
					.all(),
			},
			AbortSignal.timeout(10_000),
		);
		const refs = new Map(raw.map(({ ref }) => [ref.digest, ref.sizeBytes]));
		for (const effect of validated.selection.effects) {
			for (const state of [
				effect.before,
				effect.intendedAfter,
				effect.observedAfter,
				...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
			]) {
				if (state.kind === "regular") refs.set(state.blob.digest, state.blob.sizeBytes);
			}
		}
		for (const file of validated.files)
			for (const state of [file.expected, file.desired]) {
				if (state.kind === "regular") refs.set(state.blob.digest, state.blob.sizeBytes);
			}
		expect(validated.evidenceBytes).toBe([...refs.values()].reduce((sum, bytes) => sum + bytes, 0));
		expect(historySnapshot()).toBe(fixedHistory);
		for (let i = 0; i < 2; i++)
			expect(await readFile(join(workspace, `${i}.txt`), "utf8")).toBe("b".repeat(4096));
	});

	test("calculator rereads exhaust the planner-wide processing cap before the next IO", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		// Four historical unique blobs are read by planner, five including live current
		// by calculator; all fixture states have exactly the same raw length.
		service = new RevertPlannerService(db, { ...options, maxProcessedBytes: 10 * disk.byteLength });
		const reading = spyOn(namespace.store, "readBytes");
		try {
			(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_BUDGET_EXCEEDED" });
			expect(reading).toHaveBeenCalledTimes(9);
		} finally {
			reading.mockRestore();
		}
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});

	test("repeated real blob reads exceed independent processing cap without preparing a prefix", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		const reading = spyOn(namespace.store, "readBytes");
		service = new RevertPlannerService(db, { ...options, maxProcessedBytes: disk.byteLength });
		try {
			(await rejected(prepare())).toMatchObject({ code: "REVERT_PLANNER_BUDGET_EXCEEDED" });
			expect(reading).not.toHaveBeenCalled();
		} finally {
			reading.mockRestore();
		}
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});

	test("private intermediate merge output is capped before publication, not only counted afterwards", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		const first = await prepare();
		const selected = await rawManifest<RevertSelectionResult>(first.plan.manifestDigests.history);
		const fixed = await rawManifest<{ request: Omit<RevertPlannerRequest, "signal"> }>(
			first.plan.manifestDigests.selector,
		);
		const size = (digest: string | null) =>
			db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, digest ?? ""))
				.get()?.sizeBytes ?? 0;
		const refs = new Map<string, number>();
		for (const effect of selected.effects) {
			for (const state of [
				effect.before,
				effect.intendedAfter,
				effect.observedAfter,
				...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
			]) {
				if (state.kind === "regular") refs.set(state.blob.digest, state.blob.sizeBytes);
			}
		}
		refs.set(hash(disk), disk.byteLength);
		const inputBytes = [...refs.values()].reduce((sum, bytes) => sum + bytes, 0);
		// Same-length idempotency key keeps both serialized request lengths fixed.
		const beforeMerge =
			Buffer.byteLength(JSON.stringify({ version: 1, owner, request: fixed.request })) +
			inputBytes +
			size(first.plan.manifestDigests.history) +
			size(first.plan.manifestDigests.selector);
		service = new RevertPlannerService(db, {
			...options,
			maxEvidenceBytes: beforeMerge + disk.byteLength - 1,
		});
		const initialReads = reads;
		(await rejected(prepare({ idempotencyKey: "limited" }))).toMatchObject({
			code: "REVERT_PLANNER_REVERSAL_REFUSED",
			message: "Complete reversal refused: budget_exceeded",
		});
		expect(reads - initialReads).toBe(1);
		expect(db.select().from(schema.revertOperations).all()).toHaveLength(1);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("pre-aborted request publishes no manifests and starts no source scan", async () => {
		await fixture();
		const before = historySnapshot();
		const controller = new AbortController();
		controller.abort(new Error("cancelled preview"));
		(await rejected(prepare({ signal: controller.signal }))).toThrow("cancelled preview");
		assertUnprepared();
		expect(authentications).toBe(0);
		expect(historySnapshot()).toBe(before);
	});
	test("cancel during actual current read refuses preparation and leaves disk/history alone", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		const controller = new AbortController();
		beforeRead = () => controller.abort(new Error("cancel read"));
		(await rejected(prepare({ signal: controller.signal }))).toThrow("cancel read");
		await Promise.resolve();
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("DB begin failure never creates a prepared row", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		sqlite.exec(
			"CREATE TRIGGER fail_plan BEFORE INSERT ON revert_operations BEGIN SELECT RAISE(ABORT,'forced plan failure'); END",
		);
		(await rejected(prepare())).toThrow("forced plan failure");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("DB append failure retains only noncomplete planned journal and original pins", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		sqlite.exec(
			"CREATE TRIGGER fail_file BEFORE INSERT ON revert_operation_files BEGIN SELECT RAISE(ABORT,'forced append failure'); END",
		);
		(await rejected(prepare())).toThrow("forced append failure");
		assertUnprepared();
		const row = db.select().from(schema.revertOperations).get();
		expect(row?.status).toBe("planned");
		expect(row?.coverageComplete).toBe(false);
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
	test("DB finalize failure cannot advertise complete preparation", async () => {
		const { path } = await fixture();
		const before = historySnapshot();
		const disk = await readFile(path);
		sqlite.exec(
			"CREATE TRIGGER fail_finalize BEFORE UPDATE OF status ON revert_operations WHEN NEW.status='prepared' BEGIN SELECT RAISE(ABORT,'forced finalize failure'); END",
		);
		(await rejected(prepare())).toThrow("forced finalize failure");
		assertUnprepared();
		expect(historySnapshot()).toBe(before);
		expect(await readFile(path)).toEqual(disk);
	});
});
