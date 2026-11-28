import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import iconv from "iconv-lite";
import { FILE_CHANGE_LIMITS } from "../../shared/file-change-protocol";
import { openSchemaCopyInMemory } from "../../tests/sqlite-schema-image";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { executeTool } from "../lib/agent/tool-executor";
import { toolRegistry } from "../lib/agent/tool-registry";
import { editTool } from "../lib/agent/tools/edit";
import { structSedTool } from "../lib/agent/tools/struct-sed";
import { MAX_BATCH_OPERATIONS } from "../lib/agent/tools/struct-sed/commands";
import { writeTool } from "../lib/agent/tools/write";
import type {
	AgentConfig,
	AgentToolUse,
	ToolContext,
	ToolExecutionTarget,
} from "../lib/agent/types";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { FileChangeBlobCatalog, FileChangeBlobCatalogError } from "./file-change-blob-catalog";
import type { FileChangeBlobRelease } from "./file-change-blob-store";
import * as localIoModule from "./file-change-local-io";
import {
	createFileChangeLocalIo,
	type FileChangeLocalIo,
	fileChangeLocalIo,
} from "./file-change-local-io";
import {
	hashLocalFileChangeRequest,
	LocalFileChangeRuntime,
	type LocalFileChangeRuntimeOptions,
	withFileHistoryNotice,
	withLocalFileChangeRuntime,
} from "./file-change-runtime";
import * as footprintIo from "./file-change-write-footprint";
import { withFileWrite } from "./file-write-queue";

let root: string;
let workspace: string;
let privateRoot: string;
let sqlite: Database;
let db: ReturnType<typeof database>;
let runtime: LocalFileChangeRuntime;
let narratorId: string;
let io: FileChangeLocalIo;

function database(sqlite: Database) {
	return drizzle({ client: sqlite, schema: { ...schema, ...relations } });
}

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(await realpath(tmpdir()), "file-runtime-test-"));
	workspace = join(root, "workspace");
	privateRoot = join(root, "private");
	await mkdir(workspace);
	// Schema-only copy from the preload's isolated database. No rows, production
	// directory, migration file or application connection settings are changed.
	// A byte image built once per process replaces replaying ~550 DDL statements per case.
	sqlite = openSchemaCopyInMemory(isolatedTemplate);
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	db = database(sqlite);
	narratorId = generateId();
	db.insert(schema.narrators)
		.values({
			id: narratorId,
			title: "Local writer",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	io = { ...fileChangeLocalIo };
	runtime = makeHistoryRuntimeForTests();
});

afterEach(async () => {
	await runtime.initialize().catch(() => {});
	// Drizzle prepares uncached statements; close() alone defers native disposal until GC.
	// Strict close finalizes them before Windows removes this fixture's directory.
	sqlite.close(true);
	await rm(root, { recursive: true, force: true });
});

function namespaceDiagnosticLogs(calls: readonly (readonly unknown[])[]) {
	return calls
		.filter(([message]) => message === "File history namespace diagnostic")
		.map(([, fields]) => fields as Record<string, unknown>);
}

function makeHistoryRuntimeForTests(options: Partial<LocalFileChangeRuntimeOptions> = {}) {
	const runtime = new LocalFileChangeRuntime({
		db,
		privateRoot,
		io,
		blobStoreOptions: { minimumFreeBytes: 0 },
		...options,
	});
	// Explicit test-only injection keeps exercising the retained history machinery.
	// The production local policy has no option or environment flag to enable it.
	const internal = runtime as unknown as {
		executeBound(request: { backend: ExecutionBackend }): Promise<unknown>;
	};
	const executeBound = internal.executeBound.bind(runtime);
	internal.executeBound = (request) =>
		executeBound({
			...request,
			backend: new Proxy(request.backend, {
				get(target, property) {
					return property === "kind" ? "remote" : Reflect.get(target, property);
				},
			}),
		});
	return runtime;
}

async function callContext(
	tool: "Write" | "Edit" | "StructSed",
	path: string,
	cwd = workspace,
): Promise<ToolContext> {
	const resolved = await localBackend.resolvePathIdentity(path);
	const target: ToolExecutionTarget = Object.freeze({
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: resolved.lexicalPath,
		canonicalPath: resolved.canonicalPath,
		runtimeGeneration: 0,
		selectionSource: "local_default",
	});
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: new Date().toISOString(),
		})
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: tool,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: new Date().toISOString(),
			executionDeviceId: "local",
			executionCwd: cwd,
			executionPathFlavor: localBackend.pathFlavor,
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
			runtimeGeneration: 0,
			createdAt: new Date().toISOString(),
		})
		.run();
	return {
		narratorId,
		cwd,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: toolUseId,
		toolCallBinding: Object.freeze({ toolCallId, attempt: 1 }),
		executionTarget: target,
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

async function write(path: string, content: string, ctx?: ToolContext) {
	const context = ctx ?? (await callContext("Write", path));
	return withLocalFileChangeRuntime(runtime, () =>
		writeTool.execute({ file_path: path, content }, context),
	);
}

async function edit(path: string, old: string, next: string, ctx?: ToolContext, all = false) {
	const context = ctx ?? (await callContext("Edit", path));
	return withLocalFileChangeRuntime(runtime, () =>
		editTool.execute(
			{
				file_path: path,
				old_string: old,
				new_string: next,
				replace_all: all,
			},
			context,
		),
	);
}

function effects() {
	return db.select().from(schema.fileChangeEffects).all();
}
function operations() {
	return db.select().from(schema.fileChangeOperations).all();
}
describe("local metadata-only writes", () => {
	beforeEach(() => {
		runtime = new LocalFileChangeRuntime({ db, privateRoot, io });
	});

	test("Write/Edit/StructSed bypass blob initialization and keep metadata, counts and replay fences", async () => {
		const initialize = spyOn(runtime, "initialize").mockRejectedValue(
			new Error("legacy blob unavailable"),
		);
		try {
			const path = join(workspace, "metadata.txt");
			const ctx = await callContext("Write", path);
			const written = await write(path, "one\ntwo\n", ctx);
			expect(written.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "disabled" });
			await writeFile(join(privateRoot, "file-change-blobs"), "legacy storage placeholder");
			expect((await edit(path, "one", "first")).metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "disabled",
				linesAdded: 1,
				linesRemoved: 1,
			});
			const structural = await withLocalFileChangeRuntime(runtime, async () =>
				structSedTool.execute(
					{ file_path: path, command: "delete", address: "2", dry_run: false },
					await callContext("StructSed", path),
				),
			);
			expect(structural.isError).not.toBe(true);
			expect(structural.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "disabled",
			});
			expect(await readFile(path, "utf8")).toBe("first\n");
			expect(initialize).not.toHaveBeenCalled();
			expect(db.select().from(schema.fileChangeBlobs).all()).toHaveLength(0);
			expect(db.select().from(schema.fileChangeStorageBudgets).all()).toHaveLength(0);
			expect(db.select().from(schema.narratorFileSnapshots).all()).toHaveLength(0);
			expect(db.select().from(schema.fileAttributions).all()).toHaveLength(3);
			for (const effect of effects()) {
				expect(effect).toMatchObject({
					diskOutcome: "applied",
					attributionGrade: "unknown",
					outcome: "unknown",
					beforeBlobDigest: null,
					intendedAfterBlobDigest: null,
					observedAfterBlobDigest: null,
				});
			}
			// A new runtime cannot replay an already-linked durable attempt.
			runtime = new LocalFileChangeRuntime({ db, privateRoot, io });
			expect((await write(path, "replayed", ctx)).isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe("first\n");
		} finally {
			initialize.mockRestore();
		}
	});

	test("an unknown local mutation stays unknown without producing historical content", async () => {
		io.apply = async () => ({
			kind: "target_mutation_unknown",
			error: new Error("sync failed"),
			parentEffects: { createdPaths: [], possiblePaths: [] },
		});
		const result = await write(join(workspace, "unknown.txt"), "maybe written");
		expect(result.isError).toBe(true);
		expect(result.metadata).toMatchObject({ diskOutcome: "unknown", historyStatus: "disabled" });
		expect(effects()[0]).toMatchObject({
			diskOutcome: "unknown",
			executionConfirmed: false,
			attributionGrade: "unknown",
		});
		expect(db.select().from(schema.fileChangeBlobs).all()).toHaveLength(0);
	});
});

describe("bounded immutable request digest", () => {
	test("matches existing JSON digest including escaping and surrogate chunk boundaries", async () => {
		const units = Math.floor(FILE_CHANGE_LIMITS.streamChunkBytes / 6);
		const parts = ["Edit", "/repo/file", "/repo/file"];
		const input = {
			old_string: `${"x".repeat(units - 1)}\uD835\uDC00\uD800中文\n"\\`,
			new_string: "",
			replace_all: false,
			omitted: undefined,
			scalar: null,
			number: -0,
			"2": true,
		};
		expect(await hashLocalFileChangeRequest(parts, input)).toBe(
			referenceRequestDigest(parts, input),
		);
	});

	test("copies scalar fields and consumes identity before asynchronous hashing", async () => {
		const parts = ["Write", "/repo/file", "/repo/file"];
		const input = { content: "original" };
		const expected = referenceRequestDigest(parts, input);
		const pending = hashLocalFileChangeRequest(parts, input);
		parts[0] = "Edit";
		input.content = "changed after dispatch";
		expect(await pending).toBe(expected);
	});

	test("rejects accessors, nested values and oversized field sets without invoking user code", async () => {
		let accessed = false;
		const input = {
			get content() {
				accessed = true;
				return "secret";
			},
		};
		await expect(hashLocalFileChangeRequest(["Write"], input)).rejects.toThrow("accessors");
		expect(accessed).toBe(false);
		await expect(hashLocalFileChangeRequest(["Edit"], { nested: {} })).rejects.toThrow("scalar");
		await expect(hashLocalFileChangeRequest(["Edit"], { value: Infinity })).rejects.toThrow(
			"scalar",
		);
		const fields = Object.fromEntries(
			Array.from({ length: FILE_CHANGE_LIMITS.fileToolRequestFields + 1 }, (_, index) => [
				String(index),
				"",
			]),
		);
		await expect(hashLocalFileChangeRequest(["Write"], fields)).rejects.toThrow("fields exceed");
		expect(MAX_BATCH_OPERATIONS + 1).toBeLessThanOrEqual(FILE_CHANGE_LIMITS.fileToolRequestFields);
	});

	test("large hashing yields so cancellation can stop it before any completed digest", async () => {
		const controller = new AbortController();
		const pending = hashLocalFileChangeRequest(
			["Write"],
			{ content: "x".repeat(4 * FILE_CHANGE_LIMITS.streamChunkBytes) },
			controller.signal,
		);
		setImmediate(() => controller.abort(new Error("cancel digest")));
		await expect(pending).rejects.toThrow("cancel digest");
	});

	test("escaped JSON is budgeted incrementally rather than first allocating its complete form", async () => {
		const content = "\0".repeat(Math.floor(FILE_CHANGE_LIMITS.fileToolRequestBytes / 6) + 1);
		await expect(hashLocalFileChangeRequest(["Write"], { content })).rejects.toThrow(
			"bounded input budget",
		);
	});
});

describe("editor providers with independent history", () => {
	for (const flavor of ["posix", "windows"] as const) {
		test(`remote ${flavor} uses no Host target IO and committed proof survives absent history/after-read`, async () => {
			const paths = targetPathSemantics(flavor);
			const cwd = flavor === "windows" ? "Z:\\remote-only\\repo" : "/remote-only-no-host-repo";
			const path = paths.resolve(cwd, "target.txt");
			const binding = { runtimeEpoch: "remote-epoch", runtimeGeneration: 7 };
			const backend: ExecutionBackend = Object.assign(Object.create(localBackend), {
				deviceId: "remote-fixture",
				kind: "remote",
				pathFlavor: flavor,
				paths,
				resolvePathIdentity: async (value: string) => ({
					lexicalPath: value,
					canonicalPath: value,
					exists: true,
					runtimeGeneration: 7,
				}),
			});
			const unavailable = spyOn(runtime, "initialize").mockRejectedValue(
				new Error("history offline"),
			);
			const hostFootprint = spyOn(footprintIo, "captureLocalWriteFootprint").mockImplementation(
				async () => {
					throw new Error("Remote target reached Host footprint IO");
				},
			);
			const hostRead = spyOn(io, "read").mockImplementation(async () => {
				throw new Error("Remote target reached Host read");
			});
			let writes = 0,
				reads = 0,
				parentChecks = 0;
			const nextBytes = Buffer.from("remote save"),
				digest = createHash("sha256").update(nextBytes).digest("hex");
			try {
				const run = () =>
					runtime.executeEditor({
						requestId: generateId(),
						userId: "editor-owner",
						narratorId,
						cwd,
						lexicalPath: path,
						canonicalPath: path,
						signal: new AbortController().signal,
						// Remote editor saves are raw-v2 and carry their exact snapshot revision.
						input: { digest, hashKind: "raw-sha256", snapshotRevision: 1 },
						authorize: async () => {},
						remote: {
							backend,
							runtime: binding,
							currentRuntime: () => binding,
							rootIdentity: "remote-root-object",
							assertParent: async () => {
								parentChecks++;
							},
						},
						io: {
							deviceId: backend.deviceId,
							read: async (target) => {
								expect(target).toBe(path);
								reads++;
								return { bytes: Buffer.from("old"), mode: 0o644, identity: "remote-object" };
							},
							apply: async (input) => {
								writes++;
								expect(input.editor).toMatchObject({
									root: cwd,
									rootIdentity: "remote-root-object",
									runtime: binding,
								});
								expect(input.editor).not.toHaveProperty("leaseId");
								input.onDispatch();
								return {
									kind: "applied",
									error: null,
									parentEffects: { createdPaths: [], possiblePaths: [] },
									editorReceipt: {
										operationId: input.editor?.sourceId as string,
										outcome: "committed",
										rawDigest: digest,
										totalBytes: nextBytes.length,
									},
								};
							},
						},
						construct: () => ({
							nextBytes,
							rawDigest: digest,
							result: { hash: digest, bytes: nextBytes.length },
							lineStats: null,
						}),
					});
				expect(await run()).toMatchObject({ diskOutcome: "applied", historyStatus: "unavailable" });
				expect(await run()).toMatchObject({ diskOutcome: "applied", historyStatus: "unavailable" });
				expect(writes).toBe(2);
				// The committed receipt is the proof: only the before read, never an after re-read.
				expect(reads).toBe(2);
				expect(parentChecks).toBeGreaterThan(0);
				expect(hostFootprint).not.toHaveBeenCalled();
				expect(hostRead).not.toHaveBeenCalled();
				expect(db.select().from(schema.workspaceWriteLeases).all()).toEqual([]);
			} finally {
				unavailable.mockRestore();
				hostFootprint.mockRestore();
				hostRead.mockRestore();
			}
		});
	}
});

describe("single-file writes with independent history", () => {
	test("cancelled execution retains its independent no-dispatch audit", async () => {
		const path = join(workspace, "cancelled-audit.txt");
		await writeFile(path, "before");
		const ctx = { ...(await callContext("Write", path)), signal: AbortSignal.abort() };
		const targetRead = spyOn(io, "read");
		const targetApply = spyOn(io, "apply");
		try {
			await runtime.recordHostNoDispatch(ctx, "Write", "cancelled_before_dispatch", true);
			expect(operations()).toMatchObject([
				{
					executionOutcome: "interrupted",
					settlement: "settled",
					expectedEffectCount: 0,
					reason: "no_dispatch:cancelled_before_dispatch",
				},
			]);
			expect(effects()).toHaveLength(0);
			expect(targetRead).not.toHaveBeenCalled();
			expect(targetApply).not.toHaveBeenCalled();
			expect(await readFile(path, "utf8")).toBe("before");
		} finally {
			targetRead.mockRestore();
			targetApply.mockRestore();
		}
	});
	test("history notice describes only confirmed saves with unavailable history", () => {
		const result = {
			output: "Wrote file",
			metadata: { diskOutcome: "applied", historyStatus: "unavailable" },
		};
		expect(withFileHistoryNotice(result, "zh-CN").output).toContain(
			"文件已保存；本次文件历史不可用。",
		);
		expect(withFileHistoryNotice(result, "en").output).toContain(
			"File saved; history is unavailable for this operation.",
		);
		for (const diskOutcome of ["not_applied", "conflict", "unknown"]) {
			expect(
				withFileHistoryNotice({ ...result, metadata: { ...result.metadata, diskOutcome } }).output,
			).toBe("Wrote file");
		}
		expect(
			withFileHistoryNotice({ output: "DRY RUN", metadata: { historyStatus: "unavailable" } })
				.output,
		).toBe("DRY RUN");
		expect(withFileHistoryNotice({ ...result, isError: true }).output).toBe("Wrote file");
		expect(
			withFileHistoryNotice({
				...result,
				metadata: { diskOutcome: "applied", historyStatus: "complete" },
			}).output,
		).toBe("Wrote file");
	});
	test("isolated writer cost sample", async () => {
		const path = join(workspace, "cost-sample.txt");
		await writeFile(path, "before\n");
		const ctx = await callContext("Write", path);
		await runtime.initialize();
		let fullReads = 0;
		io = createFileChangeLocalIo({
			lstat,
			mkdir,
			async open(...args) {
				const handle = await open(...args);
				return {
					stat: (options) => handle.stat(options),
					async read(buffer, offset, length, position) {
						if (position === 0) fullReads++;
						return handle.read(buffer, offset, length, position);
					},
					write: (buffer, offset, length, position) =>
						handle.write(buffer, offset, length, position),
					truncate: (length) => handle.truncate(length),
					sync: () => handle.sync(),
					close: () => handle.close(),
				};
			},
		});
		runtime = makeHistoryRuntimeForTests();
		await runtime.initialize();
		const sql = spyOn(sqlite, "prepare");
		const started = performance.now();
		try {
			const result = await write(path, "after\n", ctx);
			expect(result.isError).not.toBe(true);
			console.info(
				"writer-cost",
				JSON.stringify({
					fullReads,
					sql: sql.mock.calls.length,
					elapsedMs: performance.now() - started,
				}),
			);
		} finally {
			sql.mockRestore();
		}
	});

	test("real Write records raw v3 history and preserves mode, CRLF and human edits", async () => {
		const path = join(workspace, "source.txt");
		await writeFile(path, "one\r\ntwo\r\n", { mode: 0o640 });
		const result = await write(path, "one\nTHREE\n");
		expect(result.isError).not.toBe(true);
		expect(result.metadata).toMatchObject({
			diskOutcome: "applied",
			historyStatus: "complete",
			fileChangeEvidence: { version: 3 },
		});
		expect(await readFile(path, "utf8")).toBe("one\r\nTHREE\r\n");
		if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o640);
		await writeFile(path, "human\r\nTHREE\r\n");
		expect((await edit(path, "THREE", "four")).isError).not.toBe(true);
		const namespace = await runtime.initialize();
		const last = effects().at(-1);
		expect(last?.diskOutcome).toBe("applied");
		if (last?.beforeStateJson.kind !== "regular") throw new Error("Expected raw before blob");
		expect(Buffer.from(await namespace.store.readBytes(last.beforeStateJson.blob)).toString()).toBe(
			"human\r\nTHREE\r\n",
		);
		expect(operations().map((op) => op.journalSeq)).toEqual([1, 2]);
		expect(db.select().from(schema.narratorFileSnapshots).all()).toEqual([]);
	});

	test("Write preserves actual GBK bytes and CRLF", async () => {
		const path = join(workspace, "gbk.txt");
		const before = "中文编码样本，保留文件原有编码和换行。\r\n".repeat(4);
		await writeFile(path, iconv.encode(before, "gbk"));
		const after = before.replace("样本", "内容");
		const previous = settings.agent.legacyEncoding;
		settings.agent.legacyEncoding = true;
		try {
			expect((await write(path, after)).isError).not.toBe(true);
			expect((await readFile(path)).equals(iconv.encode(after, "gbk"))).toBe(true);
		} finally {
			settings.agent.legacyEncoding = previous;
		}
	});

	test("a changed symlink target cannot redirect the authorized mutation", async () => {
		const original = join(workspace, "original.txt");
		const other = join(workspace, "other.txt");
		const path = join(workspace, "link.txt");
		await writeFile(original, "original");
		await writeFile(other, "other");
		await symlink(original, path);
		io.apply = async (input) => {
			await rm(path);
			await symlink(other, path);
			return fileChangeLocalIo.apply(input);
		};
		expect((await write(path, "changed")).isError).toBe(true);
		expect(await readFile(original, "utf8")).toBe("original");
		expect(await readFile(other, "utf8")).toBe("other");
	});

	test("rename-and-replace after opening preserves both descriptor and replacement", async () => {
		const path = join(workspace, "referent.txt");
		const moved = join(workspace, "moved.txt");
		await writeFile(path, "original");
		io = createFileChangeLocalIo({
			lstat,
			mkdir,
			async open(...args) {
				const handle = await open(...args);
				if ((args[1] & constants.O_RDWR) !== 0) {
					await rename(path, moved);
					await writeFile(path, "foreign");
				}
				return handle;
			},
		});
		runtime = makeHistoryRuntimeForTests();
		expect((await write(path, "tool")).isError).toBe(true);
		expect(await readFile(moved, "utf8")).toBe("original");
		expect(await readFile(path, "utf8")).toBe("foreign");
	});

	test("validation rejection records the actual no-dispatch tool attempt", async () => {
		const path = join(workspace, "reject.txt");
		await writeFile(path, "unchanged");
		expect((await edit(path, "missing", "replacement")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("unchanged");
		expect(operations()).toHaveLength(1);
		expect(operations()[0]).toMatchObject({
			effectOutcome: "no_change",
			executionBindingJson: null,
			settlement: "settled",
		});
		expect(effects()).toEqual([]);
	});

	for (const failure of ["unavailable", "pending"] as const) {
		test(`read-only preview survives ${failure} history initialization`, async () => {
			const path = join(workspace, "preview.txt");
			await writeFile(path, "before\n");
			const ctx = await callContext("StructSed", path);
			if (failure === "unavailable") await writeFile(privateRoot, "not a history directory");
			const init =
				failure === "pending"
					? spyOn(runtime, "initialize").mockImplementation(() => new Promise(() => {}))
					: undefined;
			try {
				const result = await withLocalFileChangeRuntime(runtime, () =>
					structSedTool.execute(
						{ file_path: path, command: "replace", address: "1", content: "after" },
						ctx,
					),
				);
				expect(result.isError).not.toBe(true);
				expect(result.output).toContain("DRY RUN");
				expect(result.output).not.toContain("File saved;");
				expect(result.metadata?.historyStatus).toBe("disabled");
				expect(await readFile(path, "utf8")).toBe("before\n");
				if (failure === "pending") {
					expect(init).not.toHaveBeenCalled();
					expect(operations()).toMatchObject([
						{ effectOutcome: "no_change", settlement: "settled" },
					]);
				} else expect(operations()).toEqual([]);
				expect(effects()).toEqual([]);
			} finally {
				init?.mockRestore();
			}
		}, 5000);
	}

	test("an unavailable history cwd cannot strand the target file queue", async () => {
		const path = join(workspace, "cwd-metadata.txt");
		await writeFile(path, "before");
		const resolvePath = localBackend.resolvePathIdentity.bind(localBackend);
		let metadataCalls = 0;
		const resolver = spyOn(localBackend, "resolvePathIdentity").mockImplementation(
			(value, options) => {
				if (value === workspace) {
					metadataCalls++;
					return new Promise(() => {});
				}
				return resolvePath(value, options);
			},
		);
		try {
			const first = await write(path, "first");
			expect(first.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			const second = await write(path, "second");
			expect(second.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(metadataCalls).toBe(2);
			expect(await readFile(path, "utf8")).toBe("second");
		} finally {
			resolver.mockRestore();
		}
	}, 10000);

	test("executeTool keeps a successful preview when its host history callback fails", async () => {
		const path = join(workspace, "host-preview.txt");
		await writeFile(path, "before\n");
		const ctx = await callContext("StructSed", path);
		if (!ctx.toolCallBinding) throw new Error("Missing fixture attempt");
		const binding = ctx.toolCallBinding;
		const tool: AgentToolUse = {
			toolUseId: ctx.currentToolUseId as string,
			name: "StructSed",
			input: { file_path: path, command: "replace", address: "1", content: "after" },
		};
		const config: AgentConfig = {
			narratorId,
			conversationId: narratorId,
			cwd: workspace,
			provider: "test",
			model: "test",
			signal: ctx.signal,
			permissionHandler: async () => ({ behavior: "allow" }),
			requireToolCallBinding: true,
			toolExecutionBindings: new WeakMap([[tool, binding]]),
			onToolExecutionStarting: async () => binding,
			onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
			recordToolNoDispatch: async () => {
				throw new Error("history commit failed");
			},
		};
		const previous = toolRegistry.get("StructSed");
		toolRegistry.register(structSedTool);
		try {
			const result = await withLocalFileChangeRuntime(runtime, () => executeTool(tool, config));
			expect(result.isError).not.toBe(true);
			expect(result.output).toContain("DRY RUN");
			expect(result.metadata?.historyStatus).toBe("disabled");
			expect(await readFile(path, "utf8")).toBe("before\n");
		} finally {
			if (previous) toolRegistry.register(previous);
			else toolRegistry.unregister("StructSed");
		}
	});

	test("same file across runtimes and cwd spellings captures serial before values", async () => {
		const path = join(workspace, "shared.txt");
		await writeFile(path, "zero\n");
		const enter = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let first = true;
		io.apply = async (input) => {
			if (first) {
				first = false;
				enter.resolve();
				await release.promise;
			}
			return fileChangeLocalIo.apply(input);
		};
		const a = write(path, "one\n");
		await enter.promise;
		const other = makeHistoryRuntimeForTests();
		const ctx = await callContext("Edit", path, root);
		const b = withLocalFileChangeRuntime(other, () =>
			editTool.execute({ file_path: path, old_string: "one", new_string: "two" }, ctx),
		);
		release.resolve();
		expect((await a).isError).not.toBe(true);
		expect((await b).isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("two\n");
	});

	test("a different file progresses while the first file is in actual IO", async () => {
		const aPath = join(workspace, "a.txt");
		const bPath = join(workspace, "b.txt");
		const enter = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		io.apply = async (input) => {
			if (input.canonicalPath === aPath) {
				enter.resolve();
				await release.promise;
			}
			return fileChangeLocalIo.apply(input);
		};
		const a = write(aPath, "A");
		try {
			await enter.promise;
			expect((await write(bPath, "B")).isError).not.toBe(true);
			expect(await readFile(bPath, "utf8")).toBe("B");
		} finally {
			release.resolve();
			await a;
		}
	});

	test("history settlement runs after the single-file queue releases", async () => {
		const path = join(workspace, "settle.txt");
		const observed: string[] = [];
		const finish = runtime.evidence.finishOperation.bind(runtime.evidence);
		const spy = spyOn(runtime.evidence, "finishOperation").mockImplementation((...args) => {
			void withFileWrite(
				{
					deviceId: "local",
					pathFlavor: localBackend.pathFlavor as "posix" | "windows",
					canonicalPath: path,
				},
				() => {
					observed.push("queue-free");
				},
			);
			return finish(...args);
		});
		try {
			expect((await write(path, "saved")).isError).not.toBe(true);
			await Promise.resolve();
			expect(observed).toEqual(["queue-free"]);
		} finally {
			spy.mockRestore();
		}
	});

	for (const method of ["prepareScope", "beginOperation"] as const) {
		test(`${method} failure still saves without publishing unattached blobs`, async () => {
			const path = join(workspace, `${method}.txt`);
			await writeFile(path, "before");
			const ctx = await callContext("Write", path);
			const { store } = await runtime.initialize();
			const put = spyOn(store, "putBytes");
			const record = spyOn(runtime.evidence, "recordEffect");
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			const fail = spyOn(runtime.evidence, method).mockImplementation(() => {
				throw new Error("history allocation unavailable");
			});
			try {
				const result = await write(path, "saved", ctx);
				expect(result.isError).not.toBe(true);
				expect(result.metadata).toMatchObject({
					diskOutcome: "applied",
					historyStatus: "unavailable",
				});
				expect(await readFile(path, "utf8")).toBe("saved");
				expect(put).not.toHaveBeenCalled();
				expect(record).not.toHaveBeenCalled();
				expect(namespaceDiagnosticLogs(warn.mock.calls)).toHaveLength(1);
				expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
					historyStage: method === "prepareScope" ? "prepare_scope" : "begin_operation",
				});
				expect((await write(path, "replayed", ctx)).isError).toBe(true);
				expect(await readFile(path, "utf8")).toBe("saved");
			} finally {
				fail.mockRestore();
				put.mockRestore();
				record.mockRestore();
				warn.mockRestore();
			}
			expect((await write(path, "next")).metadata?.historyStatus).toBe("complete");
		});
	}

	for (const conflict of [false, true]) {
		test(`durable request ${conflict ? "conflict" : "replay"} still prevents dispatch`, async () => {
			const path = join(workspace, "existing-operation.txt");
			await writeFile(path, "before");
			const { store } = await runtime.initialize();
			const put = spyOn(store, "putBytes");
			const apply = spyOn(io, "apply");
			const begin = runtime.evidence.beginOperation.bind(runtime.evidence);
			const spy = spyOn(runtime.evidence, "beginOperation").mockImplementation((input) => {
				begin(input);
				return begin(conflict ? { ...input, requestDigest: "0".repeat(64) } : input);
			});
			try {
				const result = await write(path, "must not write");
				expect(result.isError).toBe(true);
				expect(apply).not.toHaveBeenCalled();
				expect(put).not.toHaveBeenCalled();
				expect(await readFile(path, "utf8")).toBe("before");
			} finally {
				spy.mockRestore();
				put.mockRestore();
				apply.mockRestore();
			}
		});
	}

	test("a failed tool link retains the allocated operation's blob history", async () => {
		const path = join(workspace, "link-failure.txt");
		await writeFile(path, "before");
		const ctx = await callContext("Write", path);
		const { store } = await runtime.initialize();
		const put = spyOn(store, "putBytes");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		sqlite.exec(`CREATE TEMP TRIGGER reject_operation_link
			BEFORE UPDATE OF file_change_operation_id ON narrator_tool_calls
			BEGIN SELECT RAISE(ABORT, 'operation link unavailable'); END`);
		try {
			const result = await write(path, "saved", ctx);
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(result.isError).not.toBe(true);
			expect(await readFile(path, "utf8")).toBe("saved");
			expect(put).toHaveBeenCalledTimes(2);
			expect(effects()).toHaveLength(1);
			expect(effects()[0].beforeStateJson.kind).toBe("regular");
			expect(effects()[0].observedAfterStateJson.kind).toBe("regular");
			expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
				historyStage: "link_tool",
			});
		} finally {
			sqlite.exec("DROP TRIGGER reject_operation_link");
			put.mockRestore();
			warn.mockRestore();
		}
	});

	for (const method of ["recordEffect", "finishOperation"] as const) {
		test(`${method} failure reports applied and history unavailable, then future requests work`, async () => {
			const path = join(workspace, `${method}.txt`);
			const ctx = await callContext("Write", path);
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			const spy = spyOn(runtime.evidence, method).mockImplementation(() => {
				throw new Error("history unavailable");
			});
			try {
				const result = await write(path, "saved", ctx);
				expect(result.isError).not.toBe(true);
				expect(result.metadata).toMatchObject({
					diskOutcome: "applied",
					historyStatus: "unavailable",
				});
				expect(result.output).toContain("File saved; history is unavailable for this operation.");
				expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
					historyStage: method === "recordEffect" ? "record_effect" : "finish_operation",
				});
				expect(await readFile(path, "utf8")).toBe("saved");
				expect((await write(path, "repeat", ctx)).isError).toBe(true);
			} finally {
				spy.mockRestore();
				warn.mockRestore();
			}
			expect((await write(path, "next")).isError).not.toBe(true);
		});
	}

	test("shared initialization failure is diagnosed once per actual attempt and preserves its exception", async () => {
		let now = 0;
		runtime = makeHistoryRuntimeForTests({ historyDiagnosticClock: () => now });
		const original = new FileChangeBlobCatalogError(
			"namespace_mismatch",
			"original initialization failure",
		);
		const initialize = spyOn(
			FileChangeBlobCatalog.prototype,
			"initializeNamespace",
		).mockImplementation(() => {
			throw original;
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (attempt === 2) now = 60_000;
				const pending = runtime.initialize();
				expect(runtime.initialize()).toBe(pending);
				const results = await Promise.allSettled([
					pending,
					runtime.initialize(),
					runtime.initialize(),
				]);
				for (const result of results) {
					expect(result.status).toBe("rejected");
					if (result.status === "rejected") expect(result.reason).toBe(original);
				}
			}
			expect(initialize).toHaveBeenCalledTimes(3);
			const diagnostics = namespaceDiagnosticLogs(warn.mock.calls);
			expect(diagnostics).toHaveLength(2);
			expect(diagnostics[0]).toMatchObject({ historyStage: "initialize", failureCount: 1 });
			expect(diagnostics[1]).toMatchObject({ historyStage: "initialize", failureCount: 2 });
			expect(
				warn.mock.calls.every(([message]) => message === "File history namespace diagnostic"),
			).toBe(true);
		} finally {
			initialize.mockRestore();
			warn.mockRestore();
		}
		await runtime.initialize();
		expect(
			(await write(join(workspace, "init-recovery.txt"), "saved")).metadata?.historyStatus,
		).toBe("complete");
	});

	test("concurrent write waiters retain applied outcomes and count only their shared initialization failure", async () => {
		let now = 0;
		runtime = makeHistoryRuntimeForTests({ historyDiagnosticClock: () => now });
		const initialize = spyOn(
			FileChangeBlobCatalog.prototype,
			"initializeNamespace",
		).mockImplementation(() => {
			throw new Error("namespace unavailable");
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		let release!: () => void;
		const bothWaiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readIdentity = localIoModule.localDirectoryIdentity;
		const identity = spyOn(localIoModule, "localDirectoryIdentity").mockImplementation(
			async (path) => {
				if (path === join(privateRoot, "file-change-blobs")) await bothWaiting;
				return readIdentity(path);
			},
		);
		const initializeRuntime = runtime.initialize.bind(runtime);
		let waiting = 0;
		const waiters = spyOn(runtime, "initialize").mockImplementation(() => {
			const pending = initializeRuntime();
			if (++waiting === 2) release();
			return pending;
		});
		try {
			const paths = [join(workspace, "waiter-a.txt"), join(workspace, "waiter-b.txt")];
			// Prepare tool identities before execution so both requests share the same pending init.
			const contexts = await Promise.all(paths.map((path) => callContext("Write", path)));
			const results = await Promise.all(
				paths.map((path, index) => write(path, "saved", contexts[index])),
			);
			for (const result of results)
				expect(result.metadata).toMatchObject({
					diskOutcome: "applied",
					historyStatus: "unavailable",
				});
			expect(initialize).toHaveBeenCalledTimes(1);
			expect(namespaceDiagnosticLogs(warn.mock.calls)).toHaveLength(1);
			now = 60_000;
			await runtime.initialize().catch(() => {});
			expect(namespaceDiagnosticLogs(warn.mock.calls)[1].failureCount).toBe(1);
			expect(
				warn.mock.calls.filter(
					([message]) => message === "File history unavailable for this request",
				),
			).toHaveLength(2);
			for (const path of paths) expect(await readFile(path, "utf8")).toBe("saved");
		} finally {
			release();
			waiters.mockRestore();
			identity.mockRestore();
			initialize.mockRestore();
			warn.mockRestore();
		}
	});

	test("a real initialization budget timeout has a distinct controlled label and still saves", async () => {
		const blocked = spyOn(runtime, "initialize").mockImplementation(() => new Promise(() => {}));
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const path = join(workspace, "initialization-budget.txt");
		try {
			const result = await write(path, "saved");
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(await readFile(path, "utf8")).toBe("saved");
			const diagnostics = namespaceDiagnosticLogs(warn.mock.calls);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({
				historyStage: "initialize",
				errorCode: "history_budget_exceeded",
				errorName: "Error",
			});
			const warnings = warn.mock.calls.filter(
				([message]) => message === "File history unavailable for this request",
			);
			expect(warnings[0][1]).toMatchObject({
				error: "Error: File history preparation budget exceeded",
			});
			expect(JSON.stringify(result.metadata)).not.toContain("history_budget_exceeded");
		} finally {
			blocked.mockRestore();
			warn.mockRestore();
		}
		expect((await write(path, "recovered")).metadata?.historyStatus).toBe("complete");
	});

	test("real catalog mismatch logs stable combined fingerprints and process-scoped identity without changing binding", async () => {
		const source = await runtime.initialize();
		const budget = await source.catalog.getBudget();
		if (!budget) throw new Error("Initialized test catalog is missing its budget");
		const storedKey = "a".repeat(64);
		db.update(schema.fileChangeStorageBudgets).set({ namespaceKey: storedKey }).run();
		runtime = makeHistoryRuntimeForTests();
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const path = join(workspace, "namespace-mismatch.txt");
			const result = await write(path, "private file content");
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			const diagnostics = namespaceDiagnosticLogs(warn.mock.calls);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({
				historyStage: "initialize",
				errorCode: "namespace_mismatch",
				errorName: "FileChangeBlobCatalogError",
				identityScope: "process",
				currentKeyFingerprint: createHash("sha256").update(budget.namespaceKey).digest("hex"),
				catalog: {
					catalogStage: "initialize",
					reason: "key_mismatch",
					keysEqual: false,
					storedKeyFingerprint: createHash("sha256").update(storedKey).digest("hex"),
					currentKeyFingerprint: createHash("sha256").update(budget.namespaceKey).digest("hex"),
				},
			});
			const serialized = JSON.stringify(diagnostics);
			for (const sensitive of [
				source.sourceInstanceId,
				privateRoot,
				workspace,
				path,
				storedKey,
				budget.namespaceKey,
				"private file content",
				"SELECT",
				"namespace_key",
			])
				expect(serialized).not.toContain(sensitive);
			expect(JSON.stringify(result.metadata)).not.toContain("Fingerprint");
			expect(db.select().from(schema.fileChangeStorageBudgets).get()?.namespaceKey).toBe(storedKey);
		} finally {
			warn.mockRestore();
		}
	});

	test("diagnostic logger failure preserves the existing warning and an applied unavailable result", async () => {
		await runtime.initialize();
		const failure = new Error("original effect history failure");
		const record = spyOn(runtime.evidence, "recordEffect").mockImplementation(() => {
			throw failure;
		});
		const warn = spyOn(logger, "warn").mockImplementation((message) => {
			if (message === "File history namespace diagnostic")
				throw new Error("new diagnostic logger failed");
		});
		try {
			const path = join(workspace, "logger-failure.txt");
			const result = await write(path, "saved");
			expect(result.isError).not.toBe(true);
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(await readFile(path, "utf8")).toBe("saved");
			const warnings = warn.mock.calls.filter(
				([message]) => message === "File history unavailable for this request",
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0][1]).toMatchObject({ error: String(failure) });
			expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
				historyStage: "record_effect",
			});
			expect(JSON.stringify(result.metadata)).not.toContain("Fingerprint");
		} finally {
			record.mockRestore();
			warn.mockRestore();
		}
		expect(
			(await write(join(workspace, "logger-recovery.txt"), "saved")).metadata?.historyStatus,
		).toBe("complete");
	});

	test("wrapped publication accounting failure retains its catalog stage in the runtime diagnostic", async () => {
		const path = join(workspace, "accounting-mismatch.txt");
		await writeFile(path, "before");
		const ns = await runtime.initialize();
		const reserve = ns.catalog.reserve.bind(ns.catalog);
		const admission = spyOn(ns.catalog, "reserve").mockImplementation((...args) => {
			const lease = reserve(...args);
			return {
				...lease,
				release: (result: FileChangeBlobRelease) => {
					db.update(schema.fileChangeStorageBudgets)
						.set({ namespaceKey: "a".repeat(64) })
						.run();
					return lease.release(result);
				},
			};
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await write(path, "saved");
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(await readFile(path, "utf8")).toBe("saved");
			expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
				historyStage: "publish_before",
				catalog: { catalogStage: "publication_accounting", reason: "key_mismatch" },
			});
		} finally {
			admission.mockRestore();
			warn.mockRestore();
		}
	});

	test("intended-after publication failure is distinct from before publication and reuses successful identity context", async () => {
		const path = join(workspace, "publish-after.txt");
		await writeFile(path, "before");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const ns = await runtime.initialize();
		expect(namespaceDiagnosticLogs(warn.mock.calls)).toEqual([]);
		const put = ns.store.putBytes.bind(ns.store);
		let calls = 0;
		const publication = spyOn(ns.store, "putBytes").mockImplementation((...args) => {
			if (++calls === 2) return Promise.reject(new Error("after publication failed"));
			return put(...args);
		});
		try {
			const result = await write(path, "after");
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
				historyStage: "publish_intended_after",
				identityScope: "process",
			});
			expect(await readFile(path, "utf8")).toBe("after");
		} finally {
			publication.mockRestore();
			warn.mockRestore();
		}
		expect((await write(path, "recovered")).metadata?.historyStatus).toBe("complete");
	});

	test("failed initialization is a local history gap and is retried without resetting data", async () => {
		await writeFile(privateRoot, "not a directory");
		const path = join(workspace, "init.txt");
		const result = await write(path, "first");
		expect(result.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "unavailable" });
		await rm(privateRoot);
		const next = await write(path, "second");
		expect(next.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "complete" });
	});

	test("corrupt or unavailable before storage cannot turn a successful write into failure", async () => {
		const path = join(workspace, "blob.txt");
		await writeFile(path, "before");
		const ns = await runtime.initialize();
		const spy = spyOn(ns.store, "putBytes").mockRejectedValue(new Error("bad blob"));
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await write(path, "after");
			expect(result.metadata).toMatchObject({
				diskOutcome: "applied",
				historyStatus: "unavailable",
			});
			expect(await readFile(path, "utf8")).toBe("after");
			expect(namespaceDiagnosticLogs(warn.mock.calls)[0]).toMatchObject({
				historyStage: "publish_before",
			});
		} finally {
			spy.mockRestore();
			warn.mockRestore();
		}
		expect((await write(path, "usable")).metadata?.historyStatus).toBe("complete");
	});

	test("legacy scope quarantine is metadata and preserves the existing history", async () => {
		const path = join(workspace, "old-scope.txt");
		await write(path, "first");
		const old = effects()[0];
		const leaseId = generateId();
		const now = new Date().toISOString();
		db.insert(schema.workspaceWriteLeases)
			.values({
				leaseId,
				scopeId: old.scopeId,
				deviceId: "local",
				ownerEpoch: "old-unknown-owner",
				runtimeEpoch: "old-runtime",
				runtimeGeneration: 0,
				fencingToken: 1,
				scopeRevision: 1,
				pathFlavor: localBackend.pathFlavor as "posix" | "windows",
				status: "quarantined",
				rangesJson: { version: 1, ranges: [{ kind: "file", canonicalPath: path }] },
				mutationManifestJson: {
					version: 1,
					mutations: [{ mutationId: "old-mutation", outcome: "pending" }],
				},
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.update(schema.fileChangeScopes)
			.set({
				status: "needs_verification",
				activeMutationCount: 1,
				activeLeaseId: leaseId,
				activeLeaseEpoch: "old-unknown-owner",
			})
			.where(eq(schema.fileChangeScopes.id, old.scopeId))
			.run();
		const result = await write(path, "second");
		expect(result.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "complete" });
		expect(effects().some((row) => row.id === old.id)).toBe(true);
	});

	test("an unknown partial IO blocks only its attempt and a new request can continue", async () => {
		const path = join(workspace, "partial.txt");
		const ctx = await callContext("Write", path);
		io.apply = async (input) => {
			await writeFile(input.canonicalPath, "partial");
			return {
				kind: "target_mutation_unknown",
				error: new Error("partial IO"),
				parentEffects: { createdPaths: [], possiblePaths: [] },
			};
		};
		expect((await write(path, "wanted", ctx)).isError).toBe(true);
		expect(effects()[0]?.diskOutcome).toBe("unknown");
		io.apply = fileChangeLocalIo.apply.bind(fileChangeLocalIo);
		expect((await write(path, "repeat", ctx)).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("partial");
		expect((await write(path, "new request")).isError).not.toBe(true);
	});

	test("external same-size content changes are caught before truncation", async () => {
		const path = join(workspace, "external.txt");
		await writeFile(path, "before");
		io.apply = async (input) => {
			await writeFile(path, "human!");
			return fileChangeLocalIo.apply(input);
		};
		expect((await write(path, "tool")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("human!");
		expect(effects()[0]?.diskOutcome).toBe("not_applied");
	});

	test("real persisted attempt identity and changed canonical paths are rejected", async () => {
		const path = join(workspace, "identity.txt");
		await writeFile(path, "safe");
		const ctx = await callContext("Write", path);
		if (!ctx.toolCallBinding) throw new Error("Missing real attempt");
		db.update(schema.narratorToolCalls)
			.set({ executionOriginToolCallId: "copy" })
			.where(eq(schema.narratorToolCalls.id, ctx.toolCallBinding.toolCallId))
			.run();
		expect((await write(path, "bad", ctx)).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("safe");
	});

	test("read-only and oversized files are rejected before target IO", async () => {
		const path = join(workspace, "readonly.txt");
		await writeFile(path, "keep");
		await chmod(path, 0o444);
		try {
			expect((await write(path, "bad")).isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe("keep");
		} finally {
			await chmod(path, 0o644);
		}
		await writeFile(path, Buffer.alloc(FILE_CHANGE_LIMITS.blobBytes + 1));
		expect((await write(path, "bad")).isError).toBe(true);
	});

	test("cancelled wait performs no IO and the next independent request works", async () => {
		const path = join(workspace, "cancel.txt");
		const enter = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = withFileWrite(
			{
				deviceId: "local",
				pathFlavor: localBackend.pathFlavor as "posix" | "windows",
				canonicalPath: path,
			},
			async () => {
				enter.resolve();
				await release.promise;
			},
		);
		await enter.promise;
		const abort = new AbortController();
		const ctx = { ...(await callContext("Write", path)), signal: abort.signal };
		const pending = write(path, "cancelled", ctx);
		abort.abort(new Error("cancelled"));
		try {
			expect((await pending).isError).toBe(true);
		} finally {
			release.resolve();
			await held;
		}
		expect((await write(path, "next")).isError).not.toBe(true);
	});

	test("cancellation during confirmed IO retains applied result", async () => {
		const path = join(workspace, "during-io.txt");
		const abort = new AbortController();
		const ctx = { ...(await callContext("Write", path)), signal: abort.signal };
		io.apply = async (input) => {
			const result = await fileChangeLocalIo.apply(input);
			abort.abort();
			return result;
		};
		const result = await write(path, "persisted", ctx);
		expect(result.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "complete" });
		expect(result.isError).not.toBe(true);
	});

	test("bound StructSed applies a single substitution and reports exactly one replacement", async () => {
		const path = join(workspace, "substitute.txt");
		await writeFile(path, "alpha\r\nbeta\r\n");
		const ctx = await callContext("StructSed", path);
		const apply = spyOn(io, "apply");
		try {
			const result = await withLocalFileChangeRuntime(runtime, () =>
				structSedTool.execute(
					{
						file_path: path,
						command: "substitute",
						address: "1",
						pattern: "alpha",
						replacement: "alpha alpha",
						dry_run: false,
					},
					ctx,
				),
			);
			expect(result.isError).not.toBe(true);
			expect(result.metadata).toMatchObject({
				replacements: 1,
				diskOutcome: "applied",
				historyStatus: "complete",
			});
			expect(result.output).toContain("(1 replacement(s))");
			expect(await readFile(path, "utf8")).toBe("alpha alpha\r\nbeta\r\n");
			expect(apply).toHaveBeenCalledTimes(1);
		} finally {
			apply.mockRestore();
		}
	});

	test("bound StructSed batch counts once while preserving GBK and CRLF bytes", async () => {
		const path = join(workspace, "batch-gbk.txt");
		const source = "中文编码样本，保留文件原有编码和换行。\r\n".repeat(4);
		await writeFile(path, iconv.encode(source, "gbk"));
		const ctx = await callContext("StructSed", path);
		const previous = settings.agent.legacyEncoding;
		settings.agent.legacyEncoding = true;
		try {
			const result = await withLocalFileChangeRuntime(runtime, () =>
				structSedTool.execute(
					{
						file_path: path,
						dry_run: false,
						operations: [
							{ command: "substitute", address: "1", pattern: "样本", replacement: "内容" },
							{
								command: "substitute",
								address: "3,4",
								pattern: "样本",
								replacement: "结果",
								flags: "g",
							},
						],
					},
					ctx,
				),
			);
			expect(result.isError).not.toBe(true);
			expect(result.metadata).toMatchObject({ replacements: 3, diskOutcome: "applied" });
			expect(result.output).toContain("(3 replacement(s))");
			const expected = source
				.split("\r\n")
				.map((line, index) =>
					line.replace("样本", index === 0 ? "内容" : index >= 2 ? "结果" : "样本"),
				)
				.join("\r\n");
			expect((await readFile(path)).equals(iconv.encode(expected, "gbk"))).toBe(true);
			expect(effects()).toHaveLength(1);
		} finally {
			settings.agent.legacyEncoding = previous;
		}
	});

	test("bound StructSed refuses source drift between range resolution and the write lock", async () => {
		const path = join(workspace, "struct-drift.txt");
		await writeFile(path, "alpha\n");
		const ctx = await callContext("StructSed", path);
		let reads = 0;
		io.read = async (...args) => {
			reads++;
			await writeFile(path, "human edit\n");
			return fileChangeLocalIo.read(...args);
		};
		const apply = spyOn(io, "apply");
		try {
			const result = await withLocalFileChangeRuntime(runtime, () =>
				structSedTool.execute(
					{
						file_path: path,
						command: "substitute",
						address: "1",
						pattern: "alpha",
						replacement: "next",
						dry_run: false,
					},
					ctx,
				),
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("File changed after resolving structural ranges");
			expect(result.metadata?.diskOutcome).toBe("conflict");
			expect(reads).toBe(1);
			expect(apply).not.toHaveBeenCalled();
			expect(await readFile(path, "utf8")).toBe("human edit\n");
		} finally {
			apply.mockRestore();
		}
	});

	test("Edit overwrite creates parents and StructSed applies one guarded batch", async () => {
		const path = join(workspace, "nested", "file.ts");
		expect((await edit(path, "", "const one = 1;\nconst two = 2;\n")).isError).not.toBe(true);
		const ctx = await callContext("StructSed", path);
		const result = await withLocalFileChangeRuntime(runtime, () =>
			structSedTool.execute(
				{
					file_path: path,
					command: "replace",
					address: "1",
					content: "const one = 3;",
					dry_run: false,
				},
				ctx,
			),
		);
		expect(result.isError).not.toBe(true);
		expect(await readFile(path, "utf8")).toBe("const one = 3;\nconst two = 2;\n");
	});
});

function referenceRequestDigest(parts: string[], input: Record<string, unknown>): string {
	const digest = createHash("sha256");
	for (const value of [...parts, JSON.stringify(input)])
		digest.update(`${Buffer.byteLength(value)}:`).update(value);
	return digest.digest("hex");
}
