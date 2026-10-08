import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeRevertSelector } from "@shared/file-change-protocol";
import { readIntelligentUiFileReference } from "@shared/intelligent-ui-files";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite as isolatedTemplate } from "../../db";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/local-backend";
import type { IntelligentUiInput } from "../../lib/agent/tools/intelligent-ui";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { fileChangeLocalIo, localDirectoryIdentity } from "../file-change-local-io";
import {
	LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "../file-change-runtime";
import type { RevertPlannerAccess } from "../revert-planner-service";
import { RevertPlannerService } from "../revert-planner-service";
import { RevertSelectionService } from "../revert-selection-service";
import { RevertTransactionService } from "../revert-transaction-service";
import { createWorkspaceWriteCoordinatorState } from "../workspace-write-coordinator";
import { executeIntelligentUiTool, type UiToolDependencies } from "./runtime";

const principal = { userId: "owner", isAdmin: false };
const now = () => new Date().toISOString();
let root: string;
let workspace: string;
let sqlite: Database;
let db: ReturnType<typeof database>;
let runtime: LocalFileChangeRuntime;
let serial: number;
const restores: (() => void)[] = [];
function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	root = await mkdtemp(join(await realpath(tmpdir()), "ui-history-"));
	workspace = join(root, "workspace");
	await mkdir(workspace);
	sqlite = new Database(join(root, "isolated.sqlite"));
	sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;");
	// Only schema from preload's isolated database; never connect to the user's DB.
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	for (const { sql } of definitions) sqlite.exec(sql);
	db = database(sqlite);
	db.insert(schema.users)
		.values({
			id: principal.userId,
			username: "owner",
			passwordHash: "test-only",
			createdAt: now(),
		})
		.run();
	db.insert(schema.narrators)
		.values({
			id: "narrator",
			ownerUserId: principal.userId,
			cwd: workspace,
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
	serial = 0;
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	sqlite.close();
	await rm(root, { recursive: true, force: true });
});

async function call(input: IntelligentUiInput) {
	const path =
		input.action === "create" ? join(workspace, ".narrafork/intelligent_ui") : input.path;
	const resolved = await localBackend.resolvePathIdentity(path);
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId: "narrator",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "IntelligentUI", input }],
			createdAt: now(),
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: "narrator", messageId, seq: ++serial })
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: "narrator",
			messageId,
			toolUseId,
			toolName: "IntelligentUI",
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
			runtimeGeneration: localBackend.runtimeGeneration,
			createdAt: now(),
		})
		.run();
	const ctx: ToolContext = {
		narratorId: "narrator",
		userId: principal.userId,
		cwd: workspace,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: toolUseId,
		toolCallBinding: { toolCallId, attempt: 1 },
		workspaceContext: {
			revision: 1,
			deviceId: "local",
			cwd: workspace,
			pathFlavor: localBackend.pathFlavor === "windows" ? "windows" : "posix",
			contextKey: "fixture",
			capabilities: { switchDirectory: true },
		},
		executionTarget: {
			deviceId: "local",
			backendKind: "local",
			cwd: workspace,
			pathFlavor: localBackend.pathFlavor,
			lexicalPath: resolved.lexicalPath,
			canonicalPath: resolved.canonicalPath,
			runtimeGeneration: localBackend.runtimeGeneration,
			selectionSource: "local_default",
		},
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
	const deps: Partial<UiToolDependencies> = {
		nextId: () => "unique",
		authorizeRead: async () => {},
		authorizeWrite: async () => {},
		// Local journal projects the real attribution in this fixture's DB. Do not
		// call the legacy application's notification/snapshot projection here.
		track: async () => {},
		snapshot: async () => {
			throw new Error("Local create must not take a legacy snapshot");
		},
	};
	return {
		ctx,
		messageId,
		toolCallId,
		async execute(overrides: Partial<UiToolDependencies> = {}) {
			const result = await withLocalFileChangeRuntime(runtime, () =>
				executeIntelligentUiTool(input, ctx, { ...deps, ...overrides }),
			);
			db.update(schema.narratorToolCalls)
				.set({ status: "success", outputJson: result })
				.where(eq(schema.narratorToolCalls.id, toolCallId))
				.run();
			return result;
		},
	};
}

function access(): RevertPlannerAccess {
	return {
		async authenticate(user, signal) {
			signal.throwIfAborted();
			if (user.userId !== principal.userId || user.isAdmin) throw new Error("Unauthenticated");
		},
		async authorizeNarrator(user, row, need, signal) {
			signal.throwIfAborted();
			if (user.userId !== row.ownerUserId || need !== "write") throw new Error("Denied");
		},
		async resolveContext({ narratorId }) {
			if (narratorId !== "narrator") throw new Error("Unknown narrator");
			return { projectId: null };
		},
		async authorizeFile({ identity, principal: user, signal }) {
			signal.throwIfAborted();
			if (
				user.userId !== principal.userId ||
				identity.deviceId !== "local" ||
				!localBackend.paths.contains(workspace, identity.canonicalPath)
			)
				throw new Error("File denied");
		},
		async resolveFile({ identity }) {
			const scope = runtime.evidence.getScope(identity.scopeId);
			const binding = localFileChangeRuntimeBinding(identity.deviceId);
			if (!scope || !binding) throw new Error("Unknown scope");
			return {
				identity,
				executionBinding: { deviceId: "local", ...binding, fencingToken: scope.fencingToken },
				scopeRevision: scope.revision,
				async assertCurrent({ signal }) {
					signal.throwIfAborted();
					const live = runtime.evidence.getScope(scope.id);
					if (
						!live ||
						live.status !== "active" ||
						live.activeLeaseId ||
						live.activeMutationCount ||
						live.revision !== scope.revision ||
						live.fencingToken !== scope.fencingToken ||
						(await localDirectoryIdentity(scope.canonicalRoot)) !== scope.rootIdentityJson?.object
					)
						throw new Error("Scope changed");
				},
				async readCurrent({ signal, maxBytes }) {
					const observed = await fileChangeLocalIo.read(identity.canonicalPath, signal);
					if (!observed.bytes) return { state: { kind: "absent" }, raw: null };
					expect(observed.bytes.length).toBeLessThanOrEqual(maxBytes);
					return {
						state: {
							kind: "regular",
							mode: observed.mode,
							blob: {
								algorithm: "sha256",
								digest: createHash("sha256").update(observed.bytes).digest("hex"),
								sizeBytes: observed.bytes.length,
							},
						},
						raw: observed.bytes,
					};
				},
			};
		},
	};
}

function selection(selector: FileChangeRevertSelector) {
	return new RevertSelectionService(db, { authorize: access().authorizeNarrator }).collect({
		principal,
		narratorId: "narrator",
		expectedMessageVersion: 7,
		selector,
	});
}

describe("IntelligentUI ordinary file history", () => {
	test.each([
		"messages",
		"tool_calls",
	] as const)("create can be selected by %s and reverted through the real journal", async (kind) => {
		const created = await call({ action: "create", prefix: "demo" });
		const write = localBackend.writeFileBytes.bind(localBackend);
		const dispatch = spyOn(localBackend, "writeFileBytes").mockImplementation(
			async (path, bytes, opts) => {
				expect(opts?.exclusive).toBe(true);
				expect(opts?.signal).toBeInstanceOf(AbortSignal);
				const row = db
					.select()
					.from(schema.narratorToolCalls)
					.where(eq(schema.narratorToolCalls.id, created.toolCallId))
					.get();
				expect(row?.fileChangeOperationId).toBeString();
				expect(db.select().from(schema.fileChangeEffects).all()).toHaveLength(1);
				await write(path, bytes, opts);
			},
		);
		restores.push(() => dispatch.mockRestore());
		const result = await created.execute();
		dispatch.mockRestore();
		const journalRow = db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, created.toolCallId))
			.get();
		expect(journalRow?.fileChangeOperationId).toBeString();
		expect(db.select().from(schema.fileChangeEffects).all()).toHaveLength(1);
		const ref = readIntelligentUiFileReference(result.metadata?.intelligentUi);
		if (!ref) throw new Error("Missing UI reference");
		const entry = join(ref.directory, "App.tsx");
		expect(await readFile(entry, "utf8")).toContain("export default function App");
		expect(result.metadata?.fileChangeEvidence).toMatchObject({
			version: 2,
			outcome: "changed",
			settlement: "settled",
		});
		expect(db.select().from(schema.fileAttributions).all()).toMatchObject([
			{
				action: "write",
				toolName: "IntelligentUI",
				filePath: ".narrafork/intelligent_ui/demo-unique/App.tsx",
			},
		]);
		const selector: FileChangeRevertSelector =
			kind === "messages"
				? { kind, messageIds: [created.messageId] }
				: { kind, toolCallIds: [created.toolCallId] };
		const selected = await selection(selector);
		expect(selected.issues).toEqual([]);
		expect(selected.noDiskTools).toEqual([]);
		expect(selected.effects).toHaveLength(1);
		expect(selected.effects[0].identity.canonicalPath).toBe(entry);
		expect(selected.effects[0].before).toEqual({ kind: "absent" });
		const namespace = await runtime.initialize();
		const authorized = access();
		const budget = namespace.catalog.getBudget();
		if (!budget) throw new Error("Missing file-history namespace budget");
		const planOptions = { namespaceKey: budget.namespaceKey };
		const planner = new RevertPlannerService(db, {
			access: authorized,
			blobStore: namespace.store,
			blobCatalog: namespace.catalog,
			generation: namespace.generation,
			planOptions,
		});
		const { plan } = await planner.prepare({
			principal,
			narratorId: "narrator",
			expectedMessageVersion: 7,
			idempotencyKey: generateId(),
			kind: "history_delete",
			revertScope: "narrator",
			selector,
		});
		const transaction = new RevertTransactionService(db, {
			access: authorized,
			runtime,
			namespace,
			planOptions,
		});
		const restored = await transaction.execute({
			principal,
			narratorId: "narrator",
			planId: plan.id,
			planHash: plan.planHash ?? "",
		}).result;
		expect(restored.status).toBe("committed");
		expect(await readdir(ref.directory)).toEqual([]);
		expect(db.select().from(schema.narratorToolCalls).all()).toEqual([]);
	});

	test("show has no file-change operation, attribution or revert effect", async () => {
		const directory = join(workspace, ".narrafork/intelligent_ui/existing");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "App.tsx"), "export default () => null");
		const shown = await call({ action: "show", path: directory });
		const result = await shown.execute();
		expect(result.metadata?.fileChangeEvidence).toBeUndefined();
		expect(db.select().from(schema.fileChangeOperations).all()).toEqual([]);
		expect(db.select().from(schema.fileChangeEffects).all()).toEqual([]);
		expect(db.select().from(schema.fileAttributions).all()).toEqual([]);
		const selected = await selection({ kind: "tool_calls", toolCallIds: [shown.toolCallId] });
		expect(selected.effects).toEqual([]);
		expect(selected.issues).toEqual([]);
		expect(selected.noDiskTools).toEqual([{ toolCallId: shown.toolCallId, reason: "read_only" }]);
	});

	test.each([
		"attempt",
		"origin",
		"target",
		"status",
	])("rejects mismatched %s before directory creation", async (field) => {
		const created = await call({ action: "create", prefix: "demo" });
		db.update(schema.narratorToolCalls)
			.set(
				field === "attempt"
					? { executionAttempt: 2 }
					: field === "origin"
						? { executionOriginToolCallId: "not-live" }
						: field === "target"
							? { canonicalFilePath: join(workspace, "elsewhere") }
							: { status: "pending", executionStartedAt: null },
			)
			.where(eq(schema.narratorToolCalls.id, created.toolCallId))
			.run();
		await expect(created.execute()).rejects.toThrow("Tool-call row/attempt");
		expect(await readdir(workspace)).toEqual([]);
		expect(db.select().from(schema.fileChangeOperations).all()).toEqual([]);
	});

	test("unavailable local history never falls back to an unjournaled App.tsx write", async () => {
		await mkdir(join(root, "private"), { mode: 0o700 });
		await writeFile(join(root, "private/file-change-blobs"), "not a blob directory");
		const created = await call({ action: "create", prefix: "demo" });
		await expect(created.execute()).rejects.toThrow();
		expect(await readdir(join(workspace, ".narrafork/intelligent_ui/demo-unique"))).toEqual([]);
		expect(db.select().from(schema.fileChangeEffects).all()).toEqual([]);
	});

	test("rejects a different execution segment before any workspace mutation", async () => {
		const created = await call({ action: "create", prefix: "demo" });
		created.ctx.executionSegmentId = "another-execution-scope";
		await expect(created.execute()).rejects.toThrow("Tool-call row/attempt");
		expect(await readdir(workspace)).toEqual([]);
	});

	test("a foreign file arriving at dispatch is never overwritten or presented as reversible", async () => {
		const created = await call({ action: "create", prefix: "demo" });
		const original = localBackend.writeFileBytes.bind(localBackend);
		let entry = "";
		const dispatch = spyOn(localBackend, "writeFileBytes").mockImplementation(
			async (path, bytes, opts) => {
				entry = path;
				await writeFile(path, "foreign content");
				await original(path, bytes, opts);
			},
		);
		restores.push(() => dispatch.mockRestore());
		await expect(created.execute()).rejects.toThrow();
		expect(await readFile(entry, "utf8")).toBe("foreign content");
		expect(db.select().from(schema.fileChangeEffects).all()[0].settlement).not.toBe("settled");
	});
});
