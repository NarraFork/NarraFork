/**
 * Shared fixture for the local revert transaction suites.
 *
 * This was the head of one 3,000-line test file whose 75 real-IO cases took ~165 s on a 4-vCPU
 * CI runner — longer than any whole shard's other work. The cases now live in three files so the
 * test runner can schedule them on different shards; every file imports this module and gets the
 * identical per-test fixture (fresh workspace, file-backed WAL database, real runtime, owned
 * lifetime and teardown). Importing it registers the `beforeEach`/`afterEach` hooks.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test as nativeTest } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeState } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import { sqlite as isolatedTemplate } from "../../db";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/local-backend";
import { editTool } from "../../lib/agent/tools/edit";
import { structSedTool } from "../../lib/agent/tools/struct-sed/tool";
import { writeTool } from "../../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../../lib/agent/types";
import { closeDbWorkerConnections } from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { fileChangeLocalIo, localDirectoryIdentity } from "../file-change-local-io";
import { waitForRetiredFileChangeCleanup } from "../file-change-namespace-reset";
import {
	LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "../file-change-runtime";
import type { NarratorAclRow, NarratorPrincipal } from "../narrator-acl";
import { RevertPlanService, type RevertPlanSummary } from "../revert-plan-service";
import {
	type RevertPlannerAccess,
	type RevertPlannerRequest,
	RevertPlannerService,
} from "../revert-planner-service";
import type { RevertSelectionResult } from "../revert-selection-service";
import type { TransactionManifestRequest } from "../revert-transaction-manifest-worker";
import {
	type RevertTransactionOptions,
	RevertTransactionService,
} from "../revert-transaction-service";
import {
	createWorkspaceWriteCoordinatorState,
	type WorkspaceWriteLease,
	type WorkspaceWriteRequest,
} from "../workspace-write-coordinator";

export const principal: NarratorPrincipal = { userId: "alice", isAdmin: false };
export const owner = { subjectKey: "human:alice", narratorId: "narrator", projectId: "project" };
export const hash = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export let root: string;
export let workspace: string;
export let sqlite: Database;
export let db: ReturnType<typeof database>;
export function database(client: Database) {
	return drizzle({ client, schema: { ...schema, ...relations } });
}
export let runtime: LocalFileChangeRuntime;
export let coordinatorState: ReturnType<typeof createWorkspaceWriteCoordinatorState>;
export let namespace: Awaited<ReturnType<LocalFileChangeRuntime["initialize"]>>;
export let access: RevertPlannerAccess;
export let planner: RevertPlannerService;
export let plans: RevertPlanService;
export let service: RevertTransactionService;
export let options: RevertTransactionOptions;
export let serial: number;
export let allowedFiles: Set<string>;
export let fileHook: ((path: string, signal: AbortSignal) => void | Promise<void>) | undefined;
export let restores: (() => void)[];
export let fixtureAbort: AbortController;
export let ownedWork: Set<Promise<unknown>>;
export let fixtureSetupMs: number;
export type FixtureLifetime = {
	controller: AbortController;
	work: Set<Promise<unknown>>;
	holds: Set<() => void>;
	restores: (() => void)[];
	root?: string;
	sqlite?: Database;
	closing?: Promise<void>;
};
export let lifetime: FixtureLifetime | undefined;
export const ownedTest: ProxyHandler<typeof nativeTest> = {
	apply(register, thisArg, [label, body, options]) {
		return Reflect.apply(register, thisArg, [
			label,
			(...args: unknown[]) => {
				if (!lifetime) throw new Error("Missing transaction fixture lifetime");
				const pending = lifetime.work;
				const result = body(...args);
				return result instanceof Promise ? own(result, pending) : result;
			},
			options,
		]);
	},
	get(register, key) {
		// Bun's chainable accessors must receive the original native registration object.
		const value = Reflect.get(register, key, register);
		if (key === "each" || key === "skipIf" || key === "todoIf" || key === "failingIf")
			return (...args: unknown[]) =>
				new Proxy(Reflect.apply(value, register, args) as typeof nativeTest, ownedTest);
		if (
			typeof value === "function" &&
			["skip", "only", "todo", "failing", "concurrent", "serial"].includes(String(key))
		)
			return new Proxy(value as typeof nativeTest, ownedTest);
		return value;
	},
};
// Keep native registration/deadlines and return the body's original Promise unchanged.
export const test = new Proxy(nativeTest, ownedTest);

// Observe the original lifetime promises, without releasing production locks or
// replacing any IO/receipt behavior. Teardown must not race an early HTTP result.
export function own<T>(work: Promise<T>, pending = ownedWork): Promise<T> {
	pending.add(work);
	void work.then(
		() => pending.delete(work),
		() => pending.delete(work),
	);
	return work;
}
export function makeFixtureRuntime(...args: ConstructorParameters<typeof LocalFileChangeRuntime>) {
	const instance = new LocalFileChangeRuntime(...args);
	const pending = ownedWork;
	const namespaceAccess = instance.withNamespaceAccess.bind(instance);
	instance.withNamespaceAccess = <T>(body: () => Promise<T>, signal?: AbortSignal) =>
		own(namespaceAccess(body, signal), pending);
	const write = instance.coordinator.withWrite.bind(instance.coordinator);
	instance.coordinator.withWrite = <T>(
		request: WorkspaceWriteRequest,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	) => own(write(request, body), pending);
	return instance;
}
export function makeFixtureTransaction(
	...args: ConstructorParameters<typeof RevertTransactionService>
) {
	const instance = new RevertTransactionService(...args);
	const pending = ownedWork;
	const controller = fixtureAbort;
	const execute = instance.execute.bind(instance);
	instance.execute = (input) => {
		const signal = input.signal
			? AbortSignal.any([input.signal, controller.signal])
			: controller.signal;
		const attempt = execute({ ...input, signal });
		own(attempt.whenSettled, pending);
		return attempt;
	};
	return instance;
}

beforeEach(async () => {
	// A timed-out native hook cannot let another fixture replace globals still in use
	// by the previous original test body. The native hook deadline remains unchanged.
	await lifetime?.closing;
	const owner: FixtureLifetime = {
		controller: new AbortController(),
		work: new Set(),
		holds: new Set(),
		restores: [],
	};
	lifetime = owner;
	fixtureAbort = owner.controller;
	ownedWork = owner.work;
	restores = owner.restores;
	await own(seedFixture(owner), owner.work);
});
export async function seedFixture(owner: FixtureLifetime) {
	const setupStarted = performance.now();
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "revert-transaction-test-"));
	owner.root = root;
	workspace = join(root, "workspace");
	await fs.mkdir(workspace);
	// Byte image of the isolated DB's schema (built once per process); see the DDL note below.
	sqlite = openSchemaCopyAt(isolatedTemplate, join(root, "isolated.sqlite"));
	owner.sqlite = sqlite;
	// Match production's file-backed WAL/NORMAL durability, not SQLite's default FULL.
	// Retain zero lock waiting so a fixture never hides an unexpected competing writer.
	sqlite.exec(
		"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
	);
	expect(sqlite.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(
		1,
	);
	expect(
		sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
	).toBe("wal");
	expect(sqlite.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(0);
	// Fixture-only schema: the same file-backed WAL database and full schema, written as
	// one file image instead of hundreds of DDL statements in every (Windows) hook.
	db = database(sqlite);
	serial = 0;
	allowedFiles = new Set();
	fileHook = undefined;
	// Only synchronous fixture rows belong in this transaction; real tool IO stays outside.
	sqlite.transaction(() => {
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
	})();
	coordinatorState = createWorkspaceWriteCoordinatorState();
	runtime = makeFixtureRuntime({
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
			await fileHook?.(identity.canonicalPath, signal);
		},
		async resolveFile({ identity, signal }) {
			signal.throwIfAborted();
			if (identity.deviceId !== "local") throw new Error("No remote fallback");
			const scope = await runtime.evidence.getScope(identity.scopeId);
			const binding = localFileChangeRuntimeBinding(identity.deviceId);
			if (!scope || !binding) throw new Error("No scope/runtime");
			const executionBinding = { deviceId: "local", ...binding, fencingToken: scope.fencingToken };
			return {
				identity,
				executionBinding,
				scopeRevision: scope.revision,
				async assertCurrent({ signal }) {
					signal.throwIfAborted();
					const live = await runtime.evidence.getScope(scope.id);
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
	const planOptions = {
		namespaceKey: (await namespace.catalog.getBudget())?.namespaceKey ?? "missing",
	};
	planner = new RevertPlannerService(db, {
		access,
		blobStore: namespace.store,
		blobCatalog: namespace.catalog,
		generation: namespace.generation,
		planOptions,
	});
	plans = new RevertPlanService(db, planOptions);
	options = { access, runtime, namespace, planOptions, onSlow: () => {} };
	service = makeFixtureTransaction(db, options);
	fixtureSetupMs = performance.now() - setupStarted;
}
afterEach(() => {
	// Capture the entire owner before any await; repeated timeout hooks must share
	// one closing promise and never fetch the next fixture's root/database/globals.
	const closing = lifetime;
	if (!closing) return;
	closing.closing ??= closeFixture(closing);
	return closing.closing;
});
export async function closeFixture(closing: FixtureLifetime) {
	closing.controller.abort(new Error("Owned test fixture is closing"));
	// A failed assertion/timeout must also release test-owned fault barriers that
	// the test body never reached its finally block to release.
	for (const release of closing.holds) release();
	// Include the original body and setup promise, not just the response/worker.
	// Partial setup can still publish its own root/database to this fixed owner.
	while (closing.work.size) await Promise.allSettled([...closing.work]);
	if (closing.root) await waitForRetiredFileChangeCleanup(join(closing.root, "private"));
	expect(closing.holds.size).toBe(0);
	expect(closing.work.size).toBe(0);
	for (const restore of closing.restores.splice(0).reverse()) restore();
	const dispose = async () => {
		// Finalize Drizzle's prepared statements instead of deferring SQLite's native
		// connection disposal to GC, which leaves fixture files locked on Windows.
		closing.sqlite?.close(true);
		// Windows may still report EBUSY/EPERM briefly after all handles close.
		if (closing.root)
			await fs.rm(closing.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	};
	// Cancellation can settle a read before its retiring worker exits. Keep this
	// database closed to new reads until its local handle and directory are gone.
	if (closing.sqlite) await closeDbWorkerConnections(closing.sqlite.filename, dispose);
	else await dispose();
}
export function checkNarrator(user: NarratorPrincipal, row: NarratorAclRow) {
	if (!user.isAdmin && row.ownerUserId !== user.userId) throw new Error("Narrator denied");
}
export async function tool(
	name: "Write" | "Edit" | "StructSed",
	path: string,
	input: Record<string, unknown>,
	cwd = workspace,
	failure = false,
	actorNarratorId = "narrator",
	existingMessageId?: string,
) {
	allowedFiles.add(path);
	const resolved = await localBackend.resolvePathIdentity(path);
	const providerId = generateId();
	const messageId = existingMessageId ?? generateId();
	const toolCallId = generateId();
	const block = { type: "tool_use" as const, id: providerId, name, input };
	// Seed only fixture history synchronously; never hold this SQL transaction
	// across path resolution, permission checks or the actual tool/evidence IO.
	sqlite.transaction(() => {
		if (existingMessageId) {
			const previous = db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, messageId))
				.get();
			if (
				!previous ||
				previous.narratorId !== actorNarratorId ||
				!Array.isArray(previous.contentJson)
			)
				throw new Error("Missing tool message owned by the same actor");
			db.update(schema.narratorMessages)
				.set({ contentJson: [...(previous.contentJson ?? []), block] })
				.where(eq(schema.narratorMessages.id, messageId))
				.run();
		} else {
			db.insert(schema.narratorMessages)
				.values({
					id: messageId,
					narratorId: actorNarratorId,
					role: "assistant",
					contentJson: [{ type: "text", text: "retain" }, block],
					createdAt: now(),
				})
				.run();
			db.insert(schema.narratorMessageRefs)
				.values({ id: generateId(), narratorId: actorNarratorId, messageId, seq: ++serial })
				.run();
		}
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
	})();
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
		(name === "Write" ? writeTool : name === "StructSed" ? structSedTool : editTool).execute(
			input,
			ctx,
		),
	);
	db.update(schema.narratorToolCalls)
		.set({ status: result.isError ? "fail" : "success" })
		.where(eq(schema.narratorToolCalls.id, toolCallId))
		.run();
	expect(result.isError === true, String(result.output)).toBe(failure);
	return { messageId, toolCallId, providerId };
}
export function write(path: string, content: string, cwd?: string) {
	return tool("Write", path, { file_path: path, content }, cwd);
}
export function edit(path: string, old_string: string, new_string: string, failure = false) {
	return tool("Edit", path, { file_path: path, old_string, new_string }, workspace, failure);
}
export async function prepare(extra: Partial<RevertPlannerRequest> = {}) {
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
export function execution(plan: RevertPlanSummary, signal?: AbortSignal) {
	return service.execute({
		principal,
		narratorId: "narrator",
		planId: plan.id,
		planHash: plan.planHash ?? "",
		signal,
	});
}
export async function snapshotConsentRequired(pending: Promise<unknown>) {
	// Await the real worker lifetime outside Bun's async rejects matcher.
	const error = await pending.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain("SNAPSHOT_CONFIRMATION_REQUIRED");
}
export function history(limit = 100) {
	return JSON.stringify({
		messages: db.select().from(schema.narratorMessages).limit(limit).all(),
		refs: db.select().from(schema.narratorMessageRefs).limit(limit).all(),
		tools: db.select().from(schema.narratorToolCalls).limit(limit).all(),
	});
}
export async function twoFiles() {
	const a = join(workspace, "a.txt");
	const b = join(workspace, "b.txt");
	for (const path of [a, b]) {
		await fs.writeFile(path, "original");
		await write(path, "changed");
	}
	const plan = await prepare();
	const ordered = (await plans.listFiles(owner, plan.id)).items.sort(
		(x, y) => x.sequence - y.sequence,
	);
	return {
		a: ordered[0].identityJson.canonicalPath,
		b: ordered[1].identityJson.canonicalPath,
		plan,
	};
}
export function failHistoryCommit() {
	sqlite.exec(
		"CREATE TRIGGER reject_revert_commit BEFORE UPDATE OF status ON revert_operations WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END",
	);
}
export function operation(plan: RevertPlanSummary) {
	return db
		.select()
		.from(schema.revertOperations)
		.where(eq(schema.revertOperations.id, plan.id))
		.get();
}
export function journalFiles(plan: RevertPlanSummary, limit = 100) {
	return db
		.select()
		.from(schema.revertOperationFiles)
		.where(eq(schema.revertOperationFiles.revertOperationId, plan.id))
		.limit(limit)
		.all()
		.sort((a, b) => a.sequence - b.sequence);
}
export async function manifestRequest(
	plan: RevertPlanSummary,
): Promise<Extract<TransactionManifestRequest, { action: "validate" }>> {
	const row = operation(plan);
	if (!row) throw new Error("Missing operation");
	const raw: Extract<TransactionManifestRequest, { action: "validate" }>["raw"] = [];
	for (const digest of [
		row.planBlobDigest,
		row.selectorBlobDigest,
		row.historyManifestBlobDigest,
	]) {
		const blob = db
			.select()
			.from(schema.fileChangeBlobs)
			.where(eq(schema.fileChangeBlobs.digest, digest ?? ""))
			.get();
		if (!blob) throw new Error("Missing raw blob");
		const ref = { algorithm: "sha256" as const, digest: blob.digest, sizeBytes: blob.sizeBytes };
		raw.push({ ref, bytes: await namespace.store.readBytes(ref) });
	}
	return {
		action: "validate",
		raw,
		operation: row,
		files: journalFiles(plan),
		userId: principal.userId,
	};
}

export async function fixedEvidenceBytes(plan: RevertPlanSummary) {
	const refs = new Map<string, number>();
	let selection: RevertSelectionResult | undefined;
	for (const digest of Object.values(plan.manifestDigests)) {
		const row = db
			.select()
			.from(schema.fileChangeBlobs)
			.where(eq(schema.fileChangeBlobs.digest, digest ?? ""))
			.get();
		if (!row) throw new Error("Missing raw manifest");
		refs.set(row.digest, row.sizeBytes);
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
	const add = (state: FileChangeState) => {
		const ref =
			state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
		if (ref) {
			const previous = refs.get(ref.digest);
			if (previous !== undefined && previous !== ref.sizeBytes)
				throw new Error("Conflicting blob size");
			refs.set(ref.digest, ref.sizeBytes);
		}
	};
	for (const effect of selection.effects) {
		for (const state of [
			effect.before,
			effect.intendedAfter,
			effect.observedAfter,
			...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
		])
			add(state);
	}
	for (const file of journalFiles(plan)) {
		add(file.expectedStateJson);
		add(file.desiredStateJson);
	}
	return [...refs.values()].reduce((sum, bytes) => sum + bytes, 0);
}
/**
 * Importers cannot assign to these live bindings, yet a few cases deliberately replace the
 * fixture's service, file hook or (after a simulated reopen) its connection and runtime.
 * These setters keep that ability without making the fixture's state public mutable fields.
 */
export function setService(next: RevertTransactionService): void {
	service = next;
}
export function setFileHook(next: typeof fileHook): void {
	fileHook = next;
}
export function setReopenedDatabase(
	nextSqlite: Database,
	nextDb: ReturnType<typeof database>,
	nextRuntime: LocalFileChangeRuntime,
): void {
	sqlite = nextSqlite;
	db = nextDb;
	runtime = nextRuntime;
}

export function hold() {
	const owner = lifetime;
	if (!owner) throw new Error("Missing transaction fault-barrier owner");
	const holds = owner.holds;
	const signal = owner.controller.signal;
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		let released = false;
		release = () => {
			if (released) return;
			released = true;
			holds.delete(release);
			signal.removeEventListener("abort", release);
			resolve();
		};
		holds.add(release);
		signal.addEventListener("abort", release, { once: true });
		// A late body can create another test fault gate after teardown starts.
		// It belongs to this already-aborted owner and must never block its closing.
		if (signal.aborted) release();
	});
	return { promise, release };
}
