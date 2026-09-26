import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { and, eq } from "drizzle-orm";
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
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "./file-change-runtime";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import { RevertHistoryCommitService } from "./revert-history-commit";
import { RevertMutationJournal } from "./revert-mutation-journal";
import { RevertPlanService, type RevertPlanSummary } from "./revert-plan-service";
import {
	type RevertPlannerAccess,
	type RevertPlannerRequest,
	RevertPlannerService,
} from "./revert-planner-service";
import type { RevertSelectionResult } from "./revert-selection-service";
import {
	type RevertTransactionOptions,
	RevertTransactionService,
} from "./revert-transaction-service";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

const principal: NarratorPrincipal = { userId: "alice", isAdmin: false };
const owner = { subjectKey: "human:alice", narratorId: "narrator", projectId: "project" };
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
let root: string;
let workspace: string;
let sqlite: Database;
let db: ReturnType<typeof database>;
function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}
let runtime: LocalFileChangeRuntime;
let coordinatorState: ReturnType<typeof createWorkspaceWriteCoordinatorState>;
let namespace: Awaited<ReturnType<LocalFileChangeRuntime["initialize"]>>;
let access: RevertPlannerAccess;
let planner: RevertPlannerService;
let plans: RevertPlanService;
let service: RevertTransactionService;
let options: RevertTransactionOptions;
let serial: number;
let allowedFiles: Set<string>;
let fileHook: ((path: string) => void | Promise<void>) | undefined;
let restores: (() => void)[];

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "revert-transaction-test-"));
	workspace = join(root, "workspace");
	await fs.mkdir(workspace);
	sqlite = new Database(join(root, "isolated.sqlite"));
	sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;");
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	for (const row of definitions) sqlite.exec(row.sql);
	db = database(sqlite);
	serial = 0;
	allowedFiles = new Set();
	fileHook = undefined;
	restores = [];
	for (const id of ["alice", "bob"])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "isolated-not-a-credential", createdAt: now() })
			.run();
	db.insert(schema.projects)
		.values({
			id: "project",
			name: "Isolated",
			ownerUserId: "alice",
			gitPath: workspace,
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	for (const id of ["narrator", "fork"])
		db.insert(schema.narrators)
			.values({
				id,
				ownerUserId: "alice",
				contextProjectId: "project",
				cwd: workspace,
				messageVersion: 7,
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
	coordinatorState = createWorkspaceWriteCoordinatorState();
	runtime = new LocalFileChangeRuntime({
		db,
		privateRoot: join(root, "private"),
		coordinatorState,
		blobStoreOptions: { minimumFreeBytes: 0 },
	});
	namespace = await runtime.initialize();
	access = {
		async authenticate(user, signal) {
			signal.throwIfAborted();
			const row = db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get();
			if (!row || user.isAdmin !== (row.role === "admin")) throw new Error("Authentication denied");
		},
		async authorizeNarrator(user, row, need, signal) {
			signal.throwIfAborted();
			expect(need).toBe("write");
			checkNarrator(user, row);
		},
		async resolveContext({ principal: user, narratorId, signal }) {
			signal.throwIfAborted();
			const row = db
				.select()
				.from(schema.narrators)
				.where(eq(schema.narrators.id, narratorId))
				.get();
			if (!row) throw new Error("No narrator");
			checkNarrator(user, row);
			if (row.chapterId || !row.contextProjectId) throw new Error("Not in fixture context");
			const project = db
				.select()
				.from(schema.projects)
				.where(eq(schema.projects.id, row.contextProjectId))
				.get();
			if (!project || (!user.isAdmin && project.ownerUserId !== user.userId))
				throw new Error("Project denied");
			return { projectId: project.id };
		},
		async authorizeFile({ principal: user, owner: context, identity, signal }) {
			signal.throwIfAborted();
			await access.authenticate(user, signal);
			if (
				user.userId !== "alice" ||
				context.projectId !== "project" ||
				!allowedFiles.has(identity.canonicalPath)
			)
				throw new Error("File denied");
			await fileHook?.(identity.canonicalPath);
		},
		async resolveFile({ identity, signal }) {
			signal.throwIfAborted();
			if (identity.deviceId !== "local") throw new Error("No remote fallback");
			const scope = runtime.evidence.getScope(identity.scopeId);
			const binding = localFileChangeRuntimeBinding(identity.deviceId);
			if (!scope || !binding) throw new Error("No scope/runtime");
			const executionBinding = { deviceId: "local", ...binding, fencingToken: scope.fencingToken };
			return {
				identity,
				executionBinding,
				scopeRevision: scope.revision,
				async assertCurrent({ signal }) {
					signal.throwIfAborted();
					const live = runtime.evidence.getScope(scope.id);
					if (
						!live ||
						live.activeLeaseId ||
						live.activeMutationCount ||
						live.status !== "active" ||
						live.revision !== scope.revision ||
						live.fencingToken !== scope.fencingToken
					)
						throw new Error("Preview idle assertion refused");
					if (
						(await localDirectoryIdentity(scope.canonicalRoot)) !== scope.rootIdentityJson?.object
					)
						throw new Error("Root changed");
				},
				async readCurrent({ signal, maxBytes }) {
					const observed = await fileChangeLocalIo.read(identity.canonicalPath, signal);
					if (!observed.bytes) return { state: { kind: "absent" }, raw: null };
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
	const planOptions = { namespaceKey: namespace.catalog.getBudget()?.namespaceKey ?? "missing" };
	planner = new RevertPlannerService(db, {
		access,
		blobStore: namespace.store,
		blobCatalog: namespace.catalog,
		generation: namespace.generation,
		planOptions,
	});
	plans = new RevertPlanService(db, planOptions);
	options = { access, runtime, namespace, planOptions, onSlow: () => {} };
	service = new RevertTransactionService(db, options);
});
afterEach(async () => {
	for (const restore of restores.reverse()) restore();
	sqlite.close();
	await fs.rm(root, { recursive: true, force: true });
});
function checkNarrator(user: NarratorPrincipal, row: NarratorAclRow) {
	if (!user.isAdmin && row.ownerUserId !== user.userId) throw new Error("Narrator denied");
}
async function tool(
	name: "Write" | "Edit",
	path: string,
	input: Record<string, unknown>,
	cwd = workspace,
	failure = false,
	actorNarratorId = "narrator",
) {
	allowedFiles.add(path);
	const resolved = await localBackend.resolvePathIdentity(path);
	const providerId = generateId();
	const messageId = generateId();
	const toolCallId = generateId();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId: actorNarratorId,
			role: "assistant",
			contentJson: [
				{ type: "text", text: "retain" },
				{ type: "tool_use", id: providerId, name, input },
			],
			createdAt: now(),
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: actorNarratorId, messageId, seq: ++serial })
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: actorNarratorId,
			messageId,
			toolUseId: providerId,
			toolName: name,
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now(),
			executionDeviceId: "local",
			executionCwd: cwd,
			executionPathFlavor: localBackend.pathFlavor,
			resolvedFilePath: resolved.lexicalPath,
			canonicalFilePath: resolved.canonicalPath,
			runtimeGeneration: 0,
			createdAt: now(),
		})
		.run();
	const target: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: resolved.lexicalPath,
		canonicalPath: resolved.canonicalPath,
		runtimeGeneration: 0,
		selectionSource: "local_default",
	};
	const ctx: ToolContext = {
		narratorId: actorNarratorId,
		cwd,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: providerId,
		toolCallBinding: { toolCallId, attempt: 1 },
		executionTarget: target,
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
	const result = await withLocalFileChangeRuntime(runtime, () =>
		(name === "Write" ? writeTool : editTool).execute(input, ctx),
	);
	db.update(schema.narratorToolCalls)
		.set({ status: result.isError ? "fail" : "success" })
		.where(eq(schema.narratorToolCalls.id, toolCallId))
		.run();
	expect(result.isError === true, String(result.output)).toBe(failure);
	return { messageId, toolCallId, providerId };
}
function write(path: string, content: string, cwd?: string) {
	return tool("Write", path, { file_path: path, content }, cwd);
}
function edit(path: string, old_string: string, new_string: string, failure = false) {
	return tool("Edit", path, { file_path: path, old_string, new_string }, workspace, failure);
}
async function prepare(extra: Partial<RevertPlannerRequest> = {}) {
	return (
		await planner.prepare({
			principal,
			narratorId: "narrator",
			expectedMessageVersion: 7,
			idempotencyKey: generateId(),
			kind: "history_delete",
			revertScope: "narrator",
			selector: { kind: "all" },
			...extra,
		})
	).plan;
}
function execution(plan: RevertPlanSummary, signal?: AbortSignal) {
	return service.execute({
		principal,
		narratorId: "narrator",
		planId: plan.id,
		planHash: plan.planHash ?? "",
		signal,
	});
}
function history() {
	return JSON.stringify({
		messages: db.select().from(schema.narratorMessages).limit(100).all(),
		refs: db.select().from(schema.narratorMessageRefs).limit(100).all(),
		tools: db.select().from(schema.narratorToolCalls).limit(100).all(),
	});
}
async function twoFiles() {
	const a = join(workspace, "a.txt");
	const b = join(workspace, "b.txt");
	for (const path of [a, b]) {
		await fs.writeFile(path, "original");
		await write(path, "changed");
	}
	const plan = await prepare();
	const ordered = plans.listFiles(owner, plan.id).items.sort((x, y) => x.sequence - y.sequence);
	return {
		a: ordered[0].identityJson.canonicalPath,
		b: ordered[1].identityJson.canonicalPath,
		plan,
	};
}
function failHistoryCommit() {
	sqlite.exec(
		"CREATE TRIGGER reject_revert_commit BEFORE UPDATE OF status ON revert_operations WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END",
	);
}
function operation(plan: RevertPlanSummary) {
	return db
		.select()
		.from(schema.revertOperations)
		.where(eq(schema.revertOperations.id, plan.id))
		.get();
}
function journalFiles(plan: RevertPlanSummary) {
	return db
		.select()
		.from(schema.revertOperationFiles)
		.where(eq(schema.revertOperationFiles.revertOperationId, plan.id))
		.limit(100)
		.all()
		.sort((a, b) => a.sequence - b.sequence);
}
async function fixedEvidenceBytes(plan: RevertPlanSummary) {
	let manifests = 0;
	let selection: RevertSelectionResult | undefined;
	for (const digest of Object.values(plan.manifestDigests)) {
		const row = db
			.select()
			.from(schema.fileChangeBlobs)
			.where(eq(schema.fileChangeBlobs.digest, digest ?? ""))
			.get();
		if (!row) throw new Error("Missing raw manifest");
		manifests += row.sizeBytes;
		if (digest === plan.manifestDigests.history)
			selection = JSON.parse(
				Buffer.from(
					await namespace.store.readBytes({
						algorithm: "sha256",
						digest: row.digest,
						sizeBytes: row.sizeBytes,
					}),
				).toString(),
			) as RevertSelectionResult;
	}
	if (!selection) throw new Error("Missing fixed history");
	const size = (state: FileChangeState) => (state.kind === "regular" ? state.blob.sizeBytes : 0);
	const sourceBytes = selection.effects.reduce(
		(sum, effect) =>
			sum +
			[
				effect.before,
				effect.intendedAfter,
				effect.observedAfter,
				...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
			].reduce((total, state) => total + size(state), 0),
		0,
	);
	return (
		manifests +
		Math.max(
			sourceBytes,
			selection.operations.reduce((sum, operation) => sum + operation.evidenceBytes, 0),
		) +
		journalFiles(plan).reduce(
			(sum, file) => sum + size(file.expectedStateJson) + size(file.desiredStateJson),
			0,
		)
	);
}
function hold() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("deterministic actor interleaving model", () => {
	for (const selectedMask of [1, 3, 6, 9, 12, 15]) {
		test(`seed ${selectedMask}: reverses only the selected real actor effects across two files`, async () => {
			const ending = selectedMask % 2 ? "\r\n" : "\n";
			const paths = [
				join(workspace, `seed-${selectedMask}-a.txt`),
				join(workspace, `seed-${selectedMask}-b.txt`),
			];
			const initial = paths.map((_, file) =>
				Array.from({ length: 42 }, (_, line) => `file-${file}-line-${line}`),
			);
			const model = initial.map((lines) => [...lines]);
			const bytes = (lines: string[]) => Buffer.from(`${lines.join(ending)}${ending}`);
			for (const [file, path] of paths.entries()) {
				allowedFiles.add(path);
				await fs.writeFile(path, bytes(model[file]));
				await fs.chmod(path, file ? 0o600 : 0o644);
			}
			const actions: {
				actor: "selected" | "other" | "human";
				file: number;
				line: number;
				ordinal?: number;
			}[] = [
				{ actor: "selected", file: 0, line: 2, ordinal: 0 },
				{ actor: "selected", file: 1, line: 2, ordinal: 1 },
				{ actor: "selected", file: 0, line: 22, ordinal: 2 },
				{ actor: "selected", file: 1, line: 22, ordinal: 3 },
				{ actor: "other", file: 0, line: 32 },
				{ actor: "other", file: 1, line: 32 },
				{ actor: "human", file: 0, line: 12 },
				{ actor: "human", file: 1, line: 12 },
			];
			let random = Math.imul(selectedMask, 0x9e3779b1) >>> 0;
			for (let index = actions.length - 1; index > 0; index--) {
				random ^= random << 13;
				random ^= random >>> 17;
				random ^= random << 5;
				const other = (random >>> 0) % (index + 1);
				[actions[index], actions[other]] = [actions[other], actions[index]];
			}
			const selected = new Map<number, Awaited<ReturnType<typeof tool>>>();
			for (const action of actions) {
				const path = paths[action.file];
				const old = model[action.file][action.line];
				const next = `${action.actor}-${selectedMask}-${action.file}-${action.line}`;
				const previousBytes = bytes(model[action.file]);
				model[action.file][action.line] = next;
				if (action.actor === "human") {
					const desiredBytes = bytes(model[action.file]);
					await runtime.executeEditor({
						requestId: generateId(),
						userId: "alice",
						narratorId: "narrator",
						projectId: "project",
						cwd: workspace,
						lexicalPath: path,
						canonicalPath: path,
						signal: new AbortController().signal,
						input: { path, content: desiredBytes.toString() },
						authorize: () => access.authenticate(principal, new AbortController().signal),
						construct(before) {
							expect(before.bytes && Buffer.from(before.bytes).equals(previousBytes)).toBe(true);
							return { nextBytes: desiredBytes, result: null, lineStats: { added: 1, removed: 1 } };
						},
					});
				} else {
					const result = await tool(
						"Edit",
						path,
						{ file_path: path, old_string: `${old}${ending}`, new_string: `${next}${ending}` },
						workspace,
						false,
						action.actor === "selected" ? "narrator" : "fork",
					);
					if (action.ordinal !== undefined) selected.set(action.ordinal, result);
				}
				expect((await fs.readFile(path)).equals(bytes(model[action.file]))).toBe(true);
			}
			// A late external edit is not in any tool receipt and must also survive.
			for (const [file, path] of paths.entries()) {
				model[file][12] = `late-human-${selectedMask}-${file}`;
				await fs.writeFile(path, bytes(model[file]));
			}
			const expected = model.map((lines) => [...lines]);
			const selectedMessages: string[] = [];
			for (const action of actions) {
				if (action.ordinal === undefined || !(selectedMask & (1 << action.ordinal))) continue;
				expected[action.file][action.line] = initial[action.file][action.line];
				const target = selected.get(action.ordinal);
				if (!target) throw new Error("Real selected effect missing from model fixture");
				selectedMessages.push(target.messageId);
			}
			const originalHistory = history();
			const foreignRefs = db
				.select()
				.from(schema.narratorMessageRefs)
				.where(eq(schema.narratorMessageRefs.narratorId, "fork"))
				.limit(10)
				.all();
			const kind = selectedMask % 2 ? "revert" : "history_delete";
			const plan = await prepare({
				kind,
				selector: { kind: "messages", messageIds: selectedMessages.reverse() },
			});
			const result = await execution(plan).whenSettled;
			expect(result).toMatchObject({
				status: "committed",
				journalStatus: "committed",
				settling: false,
				reason: null,
			});
			for (const [file, path] of paths.entries()) {
				expect((await fs.readFile(path)).equals(bytes(expected[file]))).toBe(true);
				expect((await fs.lstat(path)).mode & 0o777).toBe(file ? 0o600 : 0o644);
			}
			expect(
				db
					.select()
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.narratorId, "fork"))
					.limit(10)
					.all(),
			).toEqual(foreignRefs);
			if (kind === "revert") expect(history()).toBe(originalHistory);
			else
				for (const target of selected.values()) {
					const row = db
						.select({ id: schema.narratorMessageRefs.id })
						.from(schema.narratorMessageRefs)
						.where(eq(schema.narratorMessageRefs.messageId, target.messageId))
						.get();
					expect(!!row).toBe(!selectedMessages.includes(target.messageId));
				}
			const finalHistory = history();
			await fs.writeFile(paths[0], "external-after-commit");
			expect((await execution(plan).whenSettled).status).toBe("committed");
			expect(await fs.readFile(paths[0], "utf8")).toBe("external-after-commit");
			expect(history()).toBe(finalHistory);
			expect(coordinatorState.leases.size).toBe(0);
			expect(coordinatorState.activities.size).toBe(0);
		}, 20_000);
	}
});

describe("real tools -> original prepared manifests -> local transaction", () => {
	test("A / authenticated editor / B: reverse A only preserves human and unselected B hunks; file-only history stays", async () => {
		const path = join(workspace, "hunks.txt");
		const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
		await fs.writeFile(path, original);
		const first = await write(path, original.replace("A0", "A1"));
		await runtime.executeEditor({
			requestId: generateId(),
			userId: "alice",
			narratorId: "narrator",
			projectId: "project",
			cwd: workspace,
			lexicalPath: path,
			canonicalPath: path,
			signal: new AbortController().signal,
			input: { content: "human hunk" },
			authorize: async () => {
				checkNarrator(principal, {
					id: "narrator",
					ownerUserId: "alice",
					visibility: "private",
					writeAudience: "owner",
					type: "primary",
					aclRootNarratorId: null,
					chapterId: null,
					contextProjectId: "project",
				});
			},
			construct: (before) => ({
				nextBytes: Buffer.from(
					Buffer.from(before.bytes ?? [])
						.toString()
						.replace("H0", "H1"),
				),
				result: "saved",
				lineStats: null,
			}),
		});
		await edit(path, "B0", "B1");
		const before = history();
		const plan = await prepare({
			kind: "revert",
			selector: { kind: "messages", messageIds: [first.messageId] },
		});
		const result = await execution(plan).result;
		expect(result.status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe(original.replace("H0", "H1").replace("B0", "B1"));
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: null,
		});
	});
	test("GBK/CRLF raw bytes and mode survive changed encoding settings; new file deletion is real", async () => {
		const path = join(workspace, "legacy.txt");
		const created = join(workspace, "created.txt");
		const original = iconv.encode("原始内容\r\n保留\r\n", "gbk");
		await fs.writeFile(path, original, { mode: 0o751 });
		settings.agent.legacyEncoding = true;
		await write(path, "修改内容\n保留\n");
		await write(created, "temporary\n");
		settings.agent.legacyEncoding = false;
		const plan = await prepare();
		expect((await execution(plan).result).status).toBe("committed");
		expect((await fs.readFile(path)).equals(original)).toBe(true);
		expect((await fs.stat(path)).mode & 0o7777).toBe(0o751);
		expect(await fs.exists(created)).toBe(false);
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
	test("multiple exact workspace scopes restore in one history commit", async () => {
		const other = join(root, "other-workspace");
		await fs.mkdir(other);
		for (const cwd of [workspace, other]) {
			const path = join(cwd, "file.txt");
			await fs.writeFile(path, "before");
			await write(path, "after", cwd);
		}
		const plan = await prepare();
		expect(new Set(journalFiles(plan).map((file) => file.scopeId)).size).toBe(2);
		expect((await execution(plan).result).status).toBe("committed");
		for (const cwd of [workspace, other])
			expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe("before");
		expect(
			db.select().from(schema.narrators).where(eq(schema.narrators.id, "narrator")).get()
				?.messageVersion,
		).toBe(8);
	});
	test.each([
		"committed",
		"compensated",
	] as const)("final scope-release SQL failure preserves %s outcome and explicitly reports coordination recovery", async (terminal) => {
		const other = join(root, "z-last-workspace");
		await fs.mkdir(other);
		for (const cwd of [workspace, other]) {
			const path = join(cwd, "file.txt");
			await fs.writeFile(path, "before");
			await write(path, "after", cwd);
		}
		const plan = await prepare();
		const previousHistory = history();
		const targets = journalFiles(plan)
			.map((file) => {
				const scope = runtime.evidence.getScope(file.scopeId);
				if (!scope) throw new Error("Missing real scope");
				return scope;
			})
			.sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
		expect(targets).toHaveLength(2);
		if (terminal === "compensated") failHistoryCommit();
		// The second clear fails in the coordinator's real group transaction. The
		// first scope's tentative release must roll back along with the second.
		sqlite.exec(`CREATE TRIGGER reject_transaction_scope_release BEFORE UPDATE OF active_lease_id ON file_change_scopes
			WHEN NEW.id = '${targets[1].id}' AND OLD.active_lease_id IS NOT NULL AND NEW.active_lease_id IS NULL
			BEGIN SELECT RAISE(ABORT, 'final-scope-release-failed'); END;`);
		const attempt = execution(plan);
		const result = await attempt.result;
		expect(result).toMatchObject({
			status: terminal,
			journalStatus: terminal,
			settling: false,
			reason: "COORDINATOR_RECOVERY_REQUIRED",
		});
		expect(await attempt.whenSettled).toEqual(result);
		expect(operation(plan)?.status).toBe(terminal);
		for (const cwd of [workspace, other])
			expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe(
				terminal === "committed" ? "before" : "after",
			);
		const terminalHistory = history();
		if (terminal === "compensated") expect(terminalHistory).toBe(previousHistory);
		else
			expect(
				db
					.select()
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.narratorId, "narrator"))
					.limit(100)
					.all(),
			).toHaveLength(0);
		const terminalFiles = journalFiles(plan);
		for (const file of terminalFiles) {
			expect(file.status).toBe(terminal === "committed" ? "verified" : "compensated");
			if (terminal === "committed")
				expect((file.receiptJson as { compensate: unknown }).compensate).toBeNull();
		}
		expect(coordinatorState.leases.size).toBe(2);
		const retained = targets.map((scope) => {
			const live = runtime.evidence.getScope(scope.id);
			expect(live?.activeLeaseId).toBeString();
			expect(live?.activeMutationCount).toBe(0);
			expect(runtime.coordinator.capture(scope).active).toMatchObject({
				rollbacks: 1,
				retainedRecoveryHolds: 1,
			});
			return live;
		});
		const binding = localFileChangeRuntimeBinding("local");
		if (!binding) throw new Error("Missing local runtime");
		for (const scope of targets)
			await expect(
				runtime.coordinator.withWrite({ scope, runtime: binding, waitTimeoutMs: 0 }, () => {}),
			).rejects.toThrow("busy");
		// A repeated request uses the terminal journal, never compensates committed
		// files or repeats any apply while coordinator recovery remains outstanding.
		const path = join(workspace, "file.txt");
		await fs.writeFile(path, "external after terminal result");
		expect((await execution(plan).result).status).toBe(terminal);
		expect(await fs.readFile(path, "utf8")).toBe("external after terminal result");
		expect(history()).toBe(terminalHistory);
		expect(journalFiles(plan)).toEqual(terminalFiles);
		expect(coordinatorState.leases.size).toBe(2);
		const token = [...coordinatorState.leases.keys()][0];
		if (!token) throw new Error("Missing retained actual lease capability");
		sqlite.exec("DROP TRIGGER reject_transaction_scope_release");
		runtime.coordinator.retryUncertainPersistence(token);
		// Existing explicit retry only persists recovery/quarantine and drops the
		// in-memory hold. It is NOT authority to clear a durable crash barrier.
		expect(coordinatorState.leases.size).toBe(0);
		for (const [index, scope] of targets.entries()) {
			const live = runtime.evidence.getScope(scope.id);
			expect(live).toMatchObject({
				status: "active",
				activeLeaseId: null,
				activeMutationCount: 0,
			});
			const leaseId = retained[index]?.activeLeaseId;
			if (!leaseId) throw new Error("Missing retained durable lease");
			const lease = db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.leaseId, leaseId))
				.get();
			expect(lease).toMatchObject({
				leaseId,
				scopeId: scope.id,
				status: "quarantined",
				rangesJson: {
					version: 1,
					ranges: [{ kind: "subtree", canonicalPath: scope.canonicalRoot }],
				},
				mutationManifestJson: {
					version: 1,
					mutations: terminalFiles
						.filter((file) => file.scopeId === scope.id)
						.flatMap((file) =>
							(terminal === "committed"
								? [file.applyMutationId]
								: [file.applyMutationId, file.compensateMutationId]
							).map((mutationId) => ({ mutationId, outcome: "applied" })),
						),
				},
			});
			expect(lease?.executionEndedAt).toBeString();
			expect(runtime.coordinator.capture(scope)).toMatchObject({
				status: "needs_verification",
				quarantinedLeaseCount: 1,
				active: { retainedRecoveryHolds: 0 },
			});
			// A rollback owns the whole subtree, not merely the changed file.
			for (const name of ["file.txt", "untouched-sibling.txt"])
				await expect(
					runtime.coordinator.withWrite(
						{
							scope,
							runtime: binding,
							ranges: [{ kind: "file", canonicalPath: join(scope.canonicalRoot, name) }],
						},
						() => {
							throw new Error("Quarantined subtree must not admit writes");
						},
					),
				).rejects.toThrow("verification");
		}
		expect(history()).toBe(terminalHistory);
		expect(journalFiles(plan)).toEqual(terminalFiles);
	});
	test("shared partial block rollback COWs once and atomically removes later messages", async () => {
		const path = join(workspace, "cow.txt");
		await fs.writeFile(path, "A0\n1\n2\n3\nB0\n");
		const first = await edit(path, "A0", "A1");
		await edit(path, "B0", "B1");
		db.insert(schema.narratorMessageRefs)
			.values({ id: generateId(), narratorId: "fork", messageId: first.messageId, seq: 1 })
			.run();
		const originalMessage = db
			.select()
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.id, first.messageId))
			.get();
		const plan = await prepare({
			kind: "rollback_to_block",
			selector: { kind: "after_block", messageId: first.messageId, keepThroughBlockIndex: 0 },
		});
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("A0\n1\n2\n3\nB0\n");
		const refs = db
			.select()
			.from(schema.narratorMessageRefs)
			.where(eq(schema.narratorMessageRefs.narratorId, "narrator"))
			.limit(100)
			.all();
		expect(refs).toHaveLength(1);
		expect(refs[0].messageId).not.toBe(first.messageId);
		expect(
			db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, refs[0].messageId))
				.get()?.contentJson,
		).toEqual([{ type: "text", text: "retain" }]);
		expect(
			db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, first.messageId))
				.get(),
		).toEqual(originalMessage);
		expect(
			db.select().from(schema.narrators).where(eq(schema.narrators.id, "narrator")).get()
				?.messageVersion,
		).toBe(8);
	});
	test("committed duplicate/response loss never rewrites a subsequent human edit", async () => {
		const { a, plan } = await twoFiles();
		const commit = RevertMutationJournal.prototype.commit;
		const fault = spyOn(RevertMutationJournal.prototype, "commit").mockImplementation(function (
			this: RevertMutationJournal,
			ctx,
			history,
		) {
			commit.call(this, ctx, history);
			throw new Error("response lost AFTER durable commit");
		});
		restores.push(() => fault.mockRestore());
		expect((await execution(plan).result).status).toBe("committed");
		fault.mockRestore();
		await fs.writeFile(a, "human after commit");
		const before = history();
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(a, "utf8")).toBe("human after commit");
		expect(history()).toBe(before);
	});
	test("last file full preflight rejects all target writes and leaves prepared journal/history", async () => {
		const { a, b, plan } = await twoFiles();
		await fs.chmod(b, 0o444);
		const before = history();
		await expect(execution(plan).result).rejects.toThrow("FILE_PREFLIGHT");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(await fs.readFile(b, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(operation(plan)?.status).toBe("prepared");
		expect(journalFiles(plan).every((row) => row.receiptJson === null)).toBe(true);
	});
	test("second file dispatch authorization rejection compensates earlier applied file", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		fileHook = (path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			)
				throw new Error("revoke before second dispatch");
		};
		expect((await execution(plan).result).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		const rows = journalFiles(plan);
		expect(rows[0].compensateMutationId).not.toBe(rows[0].applyMutationId);
		expect(rows[0].receiptJson).toMatchObject({
			apply: { receipt: { outcome: "applied" } },
			compensate: { receipt: { outcome: "applied" } },
		});
		expect(rows[1].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
			compensate: null,
		});
	});
	test("real SQL commit abort rolls back COW/history and compensates files in reverse", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		failHistoryCommit();
		expect((await execution(plan).result).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((row) => row.status === "compensated")).toBe(true);
	});
	test.each([
		false,
		true,
	])("compensation refuses third-party %s replacement, pins separate third-state observation", async (sameBytes) => {
		const { a, plan } = await twoFiles();
		const before = history();
		failHistoryCommit();
		const begin = RevertMutationJournal.prototype.beginCompensation;
		const change = spyOn(RevertMutationJournal.prototype, "beginCompensation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				if (sameBytes) renameSync(a, `${a}.old`);
				writeFileSync(a, sameBytes ? "original" : "third-party");
				return begin.call(this, ctx);
			},
		);
		restores.push(() => change.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(a, "utf8")).toBe(sameBytes ? "original" : "third-party");
		expect(history()).toBe(before);
		const row = journalFiles(plan)[0];
		expect(row.observedAfterBlobDigest).toBe(hash("original"));
		expect(row.compensationAfterBlobDigest).toBe(hash(sameBytes ? "original" : "third-party"));
		const scope = runtime.evidence.getScope(row.scopeId);
		if (!scope) throw new Error("Missing rollback scope");
		expect(scope).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeMutationCount: 0,
		});
		const leases = db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(
				and(
					eq(schema.workspaceWriteLeases.scopeId, row.scopeId),
					eq(schema.workspaceWriteLeases.status, "quarantined"),
				),
			)
			.limit(10)
			.all();
		expect(leases).toHaveLength(1);
		expect(leases[0]).toMatchObject({
			scopeId: row.scopeId,
			status: "quarantined",
			rangesJson: {
				version: 1,
				ranges: [{ kind: "subtree", canonicalPath: scope.canonicalRoot }],
			},
			mutationManifestJson: {
				version: 1,
				mutations: expect.arrayContaining([
					{ mutationId: row.applyMutationId, outcome: "applied" },
					{ mutationId: row.compensateMutationId, outcome: "not_applied" },
				]),
			},
		});
		expect(leases[0].executionEndedAt).toBeString();
		expect(runtime.coordinator.capture(scope)).toMatchObject({
			status: "needs_verification",
			quarantinedLeaseCount: 1,
			active: { retainedRecoveryHolds: 0 },
		});
		const binding = localFileChangeRuntimeBinding("local");
		if (!binding) throw new Error("Missing local runtime");
		for (const path of [a, join(scope.canonicalRoot, "untouched-sibling.txt")])
			await expect(
				runtime.coordinator.withWrite(
					{ scope, runtime: binding, ranges: [{ kind: "file", canonicalPath: path }] },
					() => {
						throw new Error("Quarantined subtree must not admit writes");
					},
				),
			).rejects.toThrow("verification");
		expect(await fs.readFile(a, "utf8")).toBe(sameBytes ? "original" : "third-party");
		expect(history()).toBe(before);
	});
	test("receipt SQL fault retains applying intent/quarantine; reopened DB never repeats IO", async () => {
		const { a, plan } = await twoFiles();
		const before = history();
		sqlite.exec(
			"CREATE TRIGGER reject_receipt BEFORE UPDATE OF observed_after_state_json ON revert_operation_files WHEN NEW.observed_after_state_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
		);
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({ apply: { receipt: null } });
		await fs.writeFile(a, "human after unknown write");
		sqlite.close();
		sqlite = new Database(join(root, "isolated.sqlite"));
		sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
		db = database(sqlite);
		runtime = new LocalFileChangeRuntime({
			db,
			privateRoot: join(root, "private"),
			coordinatorState: createWorkspaceWriteCoordinatorState(),
			blobStoreOptions: { minimumFreeBytes: 0 },
		});
		service = new RevertTransactionService(db, { ...options, runtime });
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(a, "utf8")).toBe("human after unknown write");
		expect(history()).toBe(before);
	});
	test("SQL failure after deleting a tool-created file recreates its exact bytes and mode", async () => {
		const path = join(workspace, "created-then-restored.txt");
		await write(path, "created bytes\r\n");
		const original = await fs.readFile(path);
		const mode = (await fs.stat(path)).mode & 0o7777;
		const before = history();
		const plan = await prepare();
		failHistoryCommit();
		expect((await execution(plan).result).status).toBe("compensated");
		expect(await fs.readFile(path)).toEqual(original);
		expect((await fs.stat(path)).mode & 0o7777).toBe(mode);
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "absent" },
			compensationAfterBlobDigest: hash(original),
			status: "compensated",
		});
	});
	test("delete compensation does not overwrite a file created externally after verified absence", async () => {
		const path = join(workspace, "created-external.txt");
		await write(path, "tool-created");
		const plan = await prepare();
		failHistoryCommit();
		const begin = RevertMutationJournal.prototype.beginCompensation;
		const change = spyOn(RevertMutationJournal.prototype, "beginCompensation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				writeFileSync(path, "external-new-file");
				return begin.call(this, ctx);
			},
		);
		restores.push(() => change.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(path, "utf8")).toBe("external-new-file");
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "absent" },
			compensationAfterBlobDigest: hash("external-new-file"),
		});
	});
	test.each([
		"history_delete",
		"revert",
	] as const)("last owner authorization external edit blocks %s commit and preserves history/third content", async (kind) => {
		const { a, plan: unused } = await twoFiles();
		const plan = kind === "history_delete" ? unused : await prepare({ kind });
		const before = history();
		const resolve = access.resolveContext.bind(access);
		let changed = false;
		const edit = spyOn(access, "resolveContext").mockImplementation(async (input) => {
			const result = await resolve(input);
			if (!changed && operation(plan)?.status === "files_verified") {
				changed = true;
				await fs.writeFile(a, "third during final owner authorization");
			}
			return result;
		});
		restores.push(() => edit.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe("third during final owner authorization");
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterBlobDigest: hash("original"),
			compensationAfterBlobDigest: hash("third during final owner authorization"),
		});
	});
	test.each([
		"during",
		"after",
	] as const)("external edit %s actual final history preparation is rechecked before synchronous commit", async (timing) => {
		const { a, plan } = await twoFiles();
		const before = history();
		let changed = false;
		const change = async () => {
			if (!changed && operation(plan)?.status === "files_verified") {
				changed = true;
				await fs.writeFile(a, "third during history prepare");
			}
		};
		if (timing === "during") {
			const authorize = access.authorizeNarrator.bind(access);
			const hook = spyOn(access, "authorizeNarrator").mockImplementation(async (...args) => {
				await authorize(...args);
				await change();
			});
			restores.push(() => hook.mockRestore());
		} else {
			const prepare = RevertHistoryCommitService.prototype.prepare;
			const hook = spyOn(RevertHistoryCommitService.prototype, "prepare").mockImplementation(
				async function (this: RevertHistoryCommitService, request) {
					const token = await prepare.call(this, request);
					await change();
					return token;
				},
			);
			restores.push(() => hook.mockRestore());
		}
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe("third during history prepare");
		expect(journalFiles(plan)[0].compensationAfterBlobDigest).toBe(
			hash("third during history prepare"),
		);
	});
	test("cleanup after revoked file ACL records unknown observation without another file read", async () => {
		const { b, plan } = await twoFiles();
		const before = history();
		let revoked = false;
		let forbiddenReads = 0;
		const read = fileChangeLocalIo.read.bind(fileChangeLocalIo);
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (path, signal) => {
			if (revoked && path === b) forbiddenReads++;
			return read(path, signal);
		});
		restores.push(() => spy.mockRestore());
		fileHook = (path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			) {
				revoked = true;
				allowedFiles.delete(b);
				throw new Error("Real file permission revoked before initial restore read");
			}
		};
		expect((await execution(plan).result).status).toBe("compensated");
		expect(revoked).toBe(true);
		expect(forbiddenReads).toBe(0);
		expect(history()).toBe(before);
		expect(await fs.readFile(b, "utf8")).toBe("changed");
		expect(journalFiles(plan)[1]).toMatchObject({
			observedAfterStateJson: { kind: "unknown", reason: "target_unverified" },
			observedAfterBlobDigest: null,
			receiptJson: {
				apply: {
					receipt: {
						confirmed: true,
						outcome: "not_applied",
						observedAfter: { kind: "unknown", reason: "target_unverified" },
					},
				},
			},
		});
	});
	test("cleanup never reads another referent after a lexical ancestor becomes a symlink", async () => {
		const nested = join(workspace, "nested");
		const moved = join(workspace, "retained-original");
		const outside = join(root, "outside-target");
		await fs.mkdir(nested);
		await fs.mkdir(outside);
		const path = join(nested, "file.txt");
		const foreign = join(outside, "file.txt");
		await fs.writeFile(path, "original");
		await fs.writeFile(foreign, "private foreign bytes");
		await write(path, "changed");
		const plan = await prepare();
		const before = history();
		let retargeted = false;
		let forbiddenReads = 0;
		const read = fileChangeLocalIo.read.bind(fileChangeLocalIo);
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (current, signal) => {
			if (retargeted && (current === path || current === foreign)) forbiddenReads++;
			return read(current, signal);
		});
		restores.push(() => spy.mockRestore());
		fileHook = async (current) => {
			if (
				!retargeted &&
				current === path &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying"
			) {
				retargeted = true;
				await fs.rename(nested, moved);
				await fs.symlink(outside, nested);
			}
		};
		expect((await execution(plan).result).status).toBe("compensated");
		expect(retargeted).toBe(true);
		expect(forbiddenReads).toBe(0);
		expect(await fs.readFile(foreign, "utf8")).toBe("private foreign bytes");
		expect(await fs.readFile(join(moved, "file.txt"), "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "unknown", reason: "target_unverified" },
			observedAfterBlobDigest: null,
			receiptJson: { apply: { receipt: { confirmed: true, outcome: "not_applied" } } },
		});
		expect(
			db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, hash("private foreign bytes")))
				.get(),
		).toBeUndefined();
	});
	test.each([
		false,
		true,
	])("low fixed evidence budget permits normal apply and SQL-compensation=%s without double charging", async (sqlFailure) => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const bytes = await fixedEvidenceBytes(plan);
		service = new RevertTransactionService(db, { ...options, maxEvidenceBytes: bytes });
		if (sqlFailure) failHistoryCommit();
		expect((await execution(plan).result).status).toBe(sqlFailure ? "compensated" : "committed");
		for (const path of [a, b])
			expect(await fs.readFile(path, "utf8")).toBe(sqlFailure ? "changed" : "original");
		if (sqlFailure) expect(history()).toBe(before);
	});
	test.each([
		false,
		true,
	])("authorized third-state evidence admission respects lowered budget: overLimit=%s", async (overLimit) => {
		const { a, plan } = await twoFiles();
		const before = history();
		const third = "third party observed after dispatch";
		const bytes = await fixedEvidenceBytes(plan);
		service = new RevertTransactionService(db, {
			...options,
			maxEvidenceBytes: bytes + Buffer.byteLength(third) - (overLimit ? 1 : 0),
		});
		let changed = false;
		fileHook = async (path) => {
			if (
				!changed &&
				path === a &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying" &&
				(await fs.readFile(a, "utf8")) === "original"
			) {
				changed = true;
				await fs.writeFile(a, third);
				throw new Error("Post-dispatch authorization interrupted before observation");
			}
		};
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe(third);
		const row = journalFiles(plan)[0];
		expect(row.receiptJson).toMatchObject({
			apply: { receipt: { confirmed: false, outcome: "unknown" } },
			compensate: null,
		});
		if (overLimit) {
			expect(row.observedAfterStateJson).toEqual({ kind: "unknown", reason: "budget_exceeded" });
			expect(row.observedAfterBlobDigest).toBeNull();
			expect(
				db
					.select()
					.from(schema.fileChangeBlobs)
					.where(eq(schema.fileChangeBlobs.digest, hash(third)))
					.get(),
			).toBeUndefined();
		} else {
			expect(row.observedAfterBlobDigest).toBe(hash(third));
			expect(row.observedAfterStateJson?.kind).toBe("regular");
		}
	});
	test("trusted transaction budget cannot raise shared ceiling or admit an over-budget fixed plan", async () => {
		const { a, plan } = await twoFiles();
		expect(
			() =>
				new RevertTransactionService(db, {
					...options,
					maxEvidenceBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes + 1,
				}),
		).toThrow("BUDGET_EXCEEDED");
		service = new RevertTransactionService(db, {
			...options,
			maxEvidenceBytes: (await fixedEvidenceBytes(plan)) - 1,
		});
		await expect(execution(plan).result).rejects.toThrow("BUDGET_EXCEEDED");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("history manifest drift without a version bump refuses before all target IO", async () => {
		const { a, plan } = await twoFiles();
		const first = db.select().from(schema.narratorMessages).limit(1).get();
		if (!first) throw new Error("Missing message");
		db.update(schema.narratorMessages)
			.set({ contentJson: [{ type: "text", text: "edited outside selected history" }] })
			.where(eq(schema.narratorMessages.id, first.id))
			.run();
		const changed = history();
		await expect(execution(plan).result).rejects.toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(history()).toBe(changed);
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("unreadable commit outcome is recovery, never permission to compensate a possibly committed history", async () => {
		const { a, plan } = await twoFiles();
		const commit = RevertMutationJournal.prototype.commit;
		const get = RevertMutationJournal.prototype.getOperation;
		let unreadable = false;
		const reads = spyOn(RevertMutationJournal.prototype, "getOperation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				if (unreadable) throw new Error("DB result unavailable");
				return get.call(this, ctx);
			},
		);
		const fault = spyOn(RevertMutationJournal.prototype, "commit").mockImplementation(function (
			this: RevertMutationJournal,
			ctx,
			history,
		) {
			commit.call(this, ctx, history);
			unreadable = true;
			throw new Error("connection response lost");
		});
		restores.push(
			() => reads.mockRestore(),
			() => fault.mockRestore(),
		);
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(operation(plan)?.status).toBe("committed");
		expect(
			journalFiles(plan).every(
				(row) => (row.receiptJson as { compensate: unknown }).compensate === null,
			),
		).toBe(true);
		expect(await fs.readFile(a, "utf8")).toBe("original");
		reads.mockRestore();
		fault.mockRestore();
		expect((await execution(plan).result).status).toBe("committed");
	});
	test("cancel before second dispatch uses independent raw-receipt and compensation budgets", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const controller = new AbortController();
		fileHook = (path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			)
				controller.abort();
		};
		const attempt = execution(plan, controller.signal);
		expect((await attempt.result).status).toBe("compensated");
		expect((await attempt.whenSettled).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[1].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
		});
	});
	test("cancel during post-dispatch guard returns bounded response but retains lease until real lifetime settles", async () => {
		const { a, plan } = await twoFiles();
		const before = history();
		const entered = hold();
		const release = hold();
		const controller = new AbortController();
		let held = false;
		service = new RevertTransactionService(db, { ...options, cleanupTimeoutMs: 50 });
		fileHook = async (path) => {
			if (
				!held &&
				path === a &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying" &&
				(await fs.readFile(a, "utf8")) === "original"
			) {
				held = true;
				entered.release();
				await release.promise;
			}
		};
		const attempt = execution(plan, controller.signal);
		try {
			await entered.promise;
			controller.abort();
			const early = await attempt.result;
			expect(early).toMatchObject({
				status: "recovery_required",
				settling: true,
				journalStatus: "applying",
			});
			const row = journalFiles(plan)[0];
			const scope = runtime.evidence.getScope(row.scopeId);
			if (!scope) throw new Error("Missing scope");
			expect(scope.activeLeaseId).toBeTruthy();
			expect(scope.activeMutationCount).toBe(1);
			expect(history()).toBe(before);
			await expect(
				runtime.coordinator.withWrite(
					{
						scope,
						runtime: localFileChangeRuntimeBinding("local") as NonNullable<
							ReturnType<typeof localFileChangeRuntimeBinding>
						>,
						waitTimeoutMs: 20,
					},
					() => {},
				),
			).rejects.toThrow();
		} finally {
			release.release();
		}
		const final = await attempt.whenSettled;
		expect(final).toMatchObject({ status: "recovery_required", settling: false });
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: false, outcome: "unknown" } },
			compensate: null,
		});
		// Same desired bytes are observation, never confirmation of the cancelled invocation.
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(history()).toBe(before);
	});
	test("already-aborted preflight performs no file IO or journal transition", async () => {
		const { a, plan } = await twoFiles();
		const controller = new AbortController();
		controller.abort();
		await expect(execution(plan, controller.signal).result).rejects.toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("raw original manifest corruption is refused before any target write", async () => {
		const { a, plan } = await twoFiles();
		const digest = plan.manifestDigests.plan ?? "";
		const path = join(root, "private", "file-change-blobs", "sha256", digest.slice(0, 2), digest);
		await fs.writeFile(path, "{}\n");
		const before = history();
		await expect(execution(plan).result).rejects.toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("lease admission detects intervening real coordinator revision/fence without re-planning", async () => {
		const { a, plan } = await twoFiles();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const delay = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			async (request, body) => {
				await runtime.coordinator.withWrite(request.scopes[0], () => {});
				return original(request, body);
			},
		);
		restores.push(() => delay.mockRestore());
		await expect(execution(plan).result).rejects.toThrow("WAITING_PLAN_STALE");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("positive current-invocation no-op is not_applied, never counted as an applied mutation", async () => {
		const path = join(workspace, "no-op.txt");
		await fs.writeFile(path, "same");
		await write(path, "same");
		const plan = await prepare();
		expect((await execution(plan).result).status).toBe("committed");
		expect(operation(plan)?.appliedFileCount).toBe(0);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
		});
	});
	test("execution request rejects client files/proof and independently rechecks authentication", async () => {
		const { a, plan } = await twoFiles();
		expect(() =>
			service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash ?? "",
				files: [],
			} as Parameters<RevertTransactionService["execute"]>[0]),
		).toThrow("INVALID_REQUEST");
		await expect(
			service.execute({
				principal: { userId: "bob", isAdmin: false },
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash ?? "",
			}).result,
		).rejects.toThrow("Narrator denied");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("positive no_dispatch zero-file history deletion uses no fabricated workspace lease", async () => {
		const path = join(workspace, "no-dispatch.txt");
		await fs.writeFile(path, "unchanged");
		await edit(path, "missing", "new", true);
		const plan = await prepare();
		expect(plan.expectedFileCount).toBe(0);
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("unchanged");
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
});
