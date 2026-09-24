import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	cp,
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
import { FILE_CHANGE_LIMITS, type FileChangeState } from "../../shared/file-change-protocol";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { decodeFileBytes } from "../lib/agent/tools/encoding";
import { structSedTool } from "../lib/agent/tools/struct-sed";
import { MAX_BATCH_OPERATIONS } from "../lib/agent/tools/struct-sed/commands";
import { writeTool } from "../lib/agent/tools/write";
import { withBashWriteLock, withWorkspaceWriteLock } from "../lib/agent/tools/write-serialization";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { worktreeWriteLock } from "../lib/async-mutex";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import type { FileChangeDiagnosticSnapshot } from "./file-change-diagnostics";
import { FileChangeEvidenceService } from "./file-change-evidence";
import {
	createFileChangeLocalIo,
	type FileChangeLocalIo,
	fileChangeLocalIo,
} from "./file-change-local-io";
import {
	FileChangeReversalCalculator,
	type FileChangeReversalEffect,
} from "./file-change-reversal";
import {
	hashLocalFileChangeRequest,
	LocalFileChangeRuntime,
	type LocalFileChangeRuntimeOptions,
	localFileChangeRuntimeBinding,
	withLocalFileChangeRuntime,
} from "./file-change-runtime";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

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
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	// Schema-only copy from the preload's isolated database. No rows, production
	// directory, migration file or application connection settings are changed.
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	for (const definition of definitions) sqlite.exec(definition.sql);
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
	runtime = makeRuntime();
});

afterEach(async () => {
	await runtime.initialize().catch(() => {});
	sqlite.close();
	await rm(root, { recursive: true, force: true });
});

function makeRuntime(options: Partial<LocalFileChangeRuntimeOptions> = {}) {
	return new LocalFileChangeRuntime({
		db,
		privateRoot,
		io,
		coordinatorState: createWorkspaceWriteCoordinatorState(),
		blobStoreOptions: { minimumFreeBytes: 0 },
		...options,
	});
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
function attributions() {
	return db.select().from(schema.fileAttributions).all();
}
function reversalEffects(): FileChangeReversalEffect[] {
	const attempts = new Map(operations().map((row) => [row.id, row.attempt]));
	return effects().map((row) => {
		const attempt = attempts.get(row.operationId);
		if (attempt === undefined) throw new Error("Missing real operation fixture");
		return {
			id: row.id,
			operationId: row.operationId,
			attempt,
			mutationId: row.mutationId,
			requestDigest: row.requestDigest,
			phase: row.phase,
			identity: row.identityJson,
			scopeRevision: row.scopeRevision,
			before: row.beforeStateJson,
			intendedAfter: row.intendedAfterStateJson,
			observedAfter: row.observedAfterStateJson,
			outcome: row.outcome,
			settlement: row.settlement,
			attribution: row.attributionGrade,
			executionConfirmed: row.executionConfirmed,
			executionReceipt: row.executionReceiptJson,
			linesAdded: row.linesAdded,
			linesRemoved: row.linesRemoved,
		};
	});
}

async function reversalFixture(path: string) {
	const { store } = await runtime.initialize();
	const currentBytes = await readFile(path);
	const current: FileChangeState = {
		kind: "regular",
		blob: await store.putBytes(currentBytes, { expectedSize: currentBytes.byteLength }),
		mode: (await lstat(path)).mode & 0o7777,
	};
	return {
		current,
		currentBytes,
		calculator: new FileChangeReversalCalculator({
			readBlob: (ref, { signal }) => store.readBytes(ref, { signal }),
			publishBlob: (bytes, options) => store.putBytes(bytes, options),
		}),
	};
}
async function bytesFor(state: FileChangeState) {
	if (state.kind === "absent") return null;
	if (state.kind !== "regular") throw new Error("Expected regular evidence");
	return (await runtime.initialize()).store.readBytes(state.blob);
}

function pendingScope() {
	return db.select().from(schema.fileChangeScopes).get();
}

function processRuntime() {
	const binding = localFileChangeRuntimeBinding();
	if (!binding) throw new Error("Local process runtime missing");
	return binding;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function referenceRequestDigest(parts: string[], input: Record<string, unknown>): string {
	const digest = createHash("sha256");
	for (const text of [...parts, JSON.stringify(input)])
		digest.update(`${Buffer.byteLength(text)}:`).update(text);
	return digest.digest("hex");
}

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

describe("actual Write/Edit local evidence", () => {
	test("creates UTF-8, references raw blobs and a PK-bound settled receipt, not legacy snapshots", async () => {
		const path = join(workspace, "new.txt");
		const ctx = await callContext("Write", path);
		const result = await write(path, "你好\n", ctx);
		expect(result.isError).toBeUndefined();
		expect(result.output).toBe(`Wrote 3 bytes to ${path}`);
		expect(await readFile(path)).toEqual(Buffer.from("你好\n"));
		const [effect] = effects();
		expect(effect).toMatchObject({
			settlement: "settled",
			outcome: "changed",
			attributionGrade: "measured",
			executionConfirmed: true,
			beforeStateJson: { kind: "absent" },
			linesAdded: 1,
			linesRemoved: 0,
		});
		expect(effect.executionReceiptJson).toMatchObject({ confirmed: true, outcome: "applied" });
		expect(await bytesFor(effect.intendedAfterStateJson)).toEqual(Buffer.from("你好\n"));
		expect(effect.observedAfterStateJson).toEqual(effect.intendedAfterStateJson);
		expect(operations()[0]).toMatchObject({
			toolCallId: ctx.toolCallBinding?.toolCallId,
			attempt: 1,
			settlement: "settled",
			executionOutcome: "succeeded",
			evidenceVersion: 2,
			journalSeq: 1,
		});
		expect(db.select().from(schema.narratorToolCalls).get()?.fileChangeOperationId).toBe(
			effect.operationId,
		);
		expect(attributions()).toHaveLength(1);
		expect(attributions()[0]).toMatchObject({
			effectId: effect.id,
			operationId: effect.operationId,
			fileKey: effect.fileKey,
			actorSubjectKey: `narrator:${narratorId}`,
			linesAdded: 1,
		});
		expect(db.select().from(schema.narratorFileSnapshots).all()).toHaveLength(0);
		expect(pendingScope()).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeMutationCount: 0,
		});
	});

	test("allocates one instance sequence for each committed file operation and effect", async () => {
		const first = join(workspace, "sequence-a.txt");
		const second = join(workspace, "sequence-b.txt");
		expect((await write(first, "a")).isError).toBeUndefined();
		expect((await write(second, "b")).isError).toBeUndefined();
		const operationRows = operations().sort((a, b) => (a.journalSeq ?? 0) - (b.journalSeq ?? 0));
		const effectRows = effects().sort((a, b) => (a.journalSeq ?? 0) - (b.journalSeq ?? 0));
		expect(operationRows.map((row) => row.journalSeq)).toEqual([1, 2]);
		expect(effectRows.map((row) => row.journalSeq)).toEqual([1, 2]);
	});

	test("Write preserves CRLF; Edit captures intervening human hunk without claiming it", async () => {
		const path = join(workspace, "crlf.txt");
		await writeFile(path, "first\r\nold\r\nlast\r\n");
		expect((await write(path, "first\nnew\nlast\n")).isError).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("first\r\nnew\r\nlast\r\n");
		await writeFile(path, "human\r\nfirst\r\nnew\r\nlast\r\n");
		const result = await edit(path, "new", "edited");
		expect(result.isError).toBeUndefined();
		expect(result.metadata).toMatchObject({ linesAdded: 1, linesRemoved: 1, startLine: 3 });
		expect(await readFile(path, "utf8")).toBe("human\r\nfirst\r\nedited\r\nlast\r\n");
		const latest = effects()[1];
		expect(await bytesFor(latest.beforeStateJson)).toEqual(
			Buffer.from("human\r\nfirst\r\nnew\r\nlast\r\n"),
		);
		expect(latest.linesAdded).toBe(1);
		expect(latest.linesRemoved).toBe(1);
	});

	test("GBK actual bytes, not re-encoded model input, are the prepared and observed after", async () => {
		settings.agent.legacyEncoding = true;
		const path = join(workspace, "gbk.txt");
		const text =
			"这是一个中文编码测试文件，包含很多常用的汉字用于识别字符编码。\r\n旧内容\r\n".repeat(10);
		const original = iconv.encode(text, "gbk");
		expect(["gbk", "gb18030"]).toContain(decodeFileBytes(original).encoding);
		await writeFile(path, original);
		const result = await edit(path, "旧内容", "新内容", undefined, true);
		expect(result.isError).toBeUndefined();
		const expected = iconv.encode(text.replaceAll("旧内容", "新内容"), "gbk");
		expect(Buffer.compare(await readFile(path), expected)).toBe(0);
		expect(await bytesFor(effects()[0].beforeStateJson)).toEqual(original);
		expect(await bytesFor(effects()[0].intendedAfterStateJson)).toEqual(expected);
	});

	test("binary before round-trips without huge decoded SQLite first-touch baselines", async () => {
		const path = join(workspace, "binary.bin");
		const before = Buffer.from([0, 255, 128, 13, 10, 3]);
		await writeFile(path, before);
		expect((await write(path, "replacement\n")).isError).toBeUndefined();
		expect(await bytesFor(effects()[0].beforeStateJson)).toEqual(before);
		expect(effects()[0].linesAdded).toBeNull();
		expect(attributions()[0].linesRemoved).toBeNull();
		expect(db.select().from(schema.narratorFileSnapshots).all()).toHaveLength(0);
	});

	test("canonical symlink cwd and referent identity are real; outside files own another scope", async () => {
		const alias = join(root, "alias");
		await symlink(workspace, alias, "dir");
		const referent = join(workspace, "referent.txt");
		await writeFile(referent, "old");
		const link = join(alias, "link.txt");
		await symlink(referent, link);
		const ctx = await callContext("Edit", link, alias);
		expect((await edit(link, "old", "new", ctx)).isError).toBeUndefined();
		expect(await readFile(referent, "utf8")).toBe("new");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(effects()[0].identityJson).toMatchObject({
			canonicalPath: referent,
			lexicalPath: link,
			objectRole: "referent",
			displayPath: "referent.txt",
		});
		expect(attributions()[0].workspacePath).toBe(workspace);
		const outside = join(root, "outside", "file.txt");
		await mkdir(join(root, "outside"));
		expect((await write(outside, "outside")).isError).toBeUndefined();
		expect(effects()[1].scopeId).not.toBe(effects()[0].scopeId);
		expect(attributions()[1].workspacePath).toBe(join(root, "outside"));
	});

	test("POSIX backslash remains filename data", async () => {
		const path = join(workspace, "literal\\name.txt");
		expect((await write(path, "content")).isError).toBeUndefined();
		expect(effects()[0].identityJson.displayPath).toBe("literal\\name.txt");
		expect(await readFile(path, "utf8")).toBe("content");
	});

	test("Edit overwrite creates missing parents and preserves replacement fallbacks", async () => {
		const path = join(workspace, "sub", "create.txt");
		expect((await edit(path, "", "  first\n  second\n")).isError).toBeUndefined();
		const result = await edit(path, "first\nsecond", "changed");
		expect(result.isError).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("changed\n");
		expect(result.metadata).toMatchObject({ linesAdded: 1, linesRemoved: 2 });
	});

	test("same persisted mutation is not dispatched twice, including an input change", async () => {
		const path = join(workspace, "once.txt");
		const ctx = await callContext("Write", path);
		const apply = spyOn(io, "apply");
		expect((await write(path, "first", ctx)).isError).toBeUndefined();
		expect((await write(path, "second", ctx)).isError).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await readFile(path, "utf8")).toBe("first");
		expect(effects()).toHaveLength(1);
		expect(attributions()).toHaveLength(1);
	});
});

describe("actual tool evidence drives reversal calculation without workspace writes", () => {
	test("Edit A, external hunk, Edit B and a later external hunk retain human bytes", async () => {
		const path = join(workspace, "combined.txt");
		const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
		await writeFile(path, original);
		expect((await edit(path, "A0", "A1")).isError).not.toBe(true);
		await writeFile(path, (await readFile(path, "utf8")).replace("H0", "H1"));
		expect((await edit(path, "B0", "B1")).isError).not.toBe(true);
		await writeFile(path, (await readFile(path, "utf8")).replace("H1", "H2"));
		const selected = reversalEffects();
		expect(selected).toHaveLength(2);
		const { calculator, current, currentBytes } = await reversalFixture(path);
		const latest = selected.toSorted((a, b) => b.scopeRevision - a.scopeRevision)[0];
		if (!latest) throw new Error("Missing actual effect");
		const justB = await calculator.calculate({
			identity: latest.identity,
			current,
			effects: [latest],
		});
		if (!justB.ok) throw new Error(justB.reason);
		expect(Buffer.from((await bytesFor(justB.desired)) ?? []).toString()).toBe(
			original.replace("A0", "A1").replace("H0", "H2"),
		);
		const both = await calculator.calculate({
			identity: latest.identity,
			current,
			effects: selected,
		});
		if (!both.ok) throw new Error(both.reason);
		expect(Buffer.from((await bytesFor(both.desired)) ?? []).toString()).toBe(
			original.replace("H0", "H2"),
		);
		expect(await readFile(path)).toEqual(currentBytes);
		expect(attributions()).toHaveLength(2);
	});

	test("GBK evidence from the real Write restores original raw bytes after the encoding setting changes", async () => {
		const path = join(workspace, "combined-gbk.txt");
		const original = iconv.encode("原始内容\r\n保留\r\n", "gbk");
		await writeFile(path, original);
		settings.agent.legacyEncoding = true;
		expect((await write(path, "修改内容\n保留\n")).isError).not.toBe(true);
		settings.agent.legacyEncoding = false;
		const selected = reversalEffects();
		const effect = selected[0];
		if (!effect) throw new Error("Missing actual GBK effect");
		const { calculator, current, currentBytes } = await reversalFixture(path);
		const result = await calculator.calculate({
			identity: effect.identity,
			current,
			effects: selected,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(Buffer.from((await bytesFor(result.desired)) ?? []).equals(original)).toBe(true);
		expect(await readFile(path)).toEqual(currentBytes);
	});
});

describe("fail closed before writes and after uncertain IO", () => {
	test("read-only and oversized raw before files never dispatch", async () => {
		const readonly = join(workspace, "readonly.txt");
		await writeFile(readonly, "old");
		await chmod(readonly, 0o444);
		const apply = spyOn(io, "apply");
		expect((await write(readonly, "new")).isError).toBe(true);
		expect(await readFile(readonly, "utf8")).toBe("old");
		const large = join(workspace, "large.txt");
		const file = await open(large, "w");
		await file.truncate(32 * 1024 * 1024 + 1);
		await file.close();
		expect((await write(large, "new")).isError).toBe(true);
		expect((await lstat(large)).size).toBe(32 * 1024 * 1024 + 1);
		expect(apply).not.toHaveBeenCalled();
		expect(effects()).toHaveLength(0);
	});

	test("unreadable before is not absence and infrastructure failure is not no-change", async () => {
		const path = join(workspace, "secret.txt");
		await writeFile(path, "old");
		io.read = async () => {
			throw Object.assign(new Error("permission-denied"), { code: "EACCES" });
		};
		const result = await write(path, "new");
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(operations()).toHaveLength(0);
		expect(effects()).toHaveLength(0);
	});

	test("failed Edit replacement is zero-effect and never makes a legacy baseline", async () => {
		const path = join(workspace, "match.txt");
		await writeFile(path, "one\ntwo\n");
		const apply = spyOn(io, "apply");
		const result = await edit(path, "missing", "new");
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
		expect(apply).not.toHaveBeenCalled();
		expect(effects()).toHaveLength(0);
		expect(attributions()).toHaveLength(0);
		expect(operations()).toHaveLength(1);
		expect(operations()[0]).toMatchObject({
			expectedEffectCount: 0,
			preparedEffectCount: 0,
			settledEffectCount: 0,
			coverage: "complete",
			settlement: "settled",
			executionOutcome: "failed",
			effectOutcome: "no_change",
			reason: "no_dispatch:validation_rejected",
		});
		expect(db.select().from(schema.narratorToolCalls).get()?.fileChangeOperationId).toBe(
			operations()[0].id,
		);
		expect(db.select().from(schema.narratorFileSnapshots).all()).toHaveLength(0);
	});

	test("identical and missing Edit preserve errors and durable zero-effect references", async () => {
		const path = join(workspace, "invalid-edit.txt");
		await writeFile(path, "same");
		const same = await edit(path, "same", "same");
		expect(same.output).toBe("No changes to apply: old_string and new_string are identical.");
		const missing = join(workspace, "missing.txt");
		expect((await edit(missing, "old", "new")).output).toBe(`File not found: ${missing}`);
		expect(operations()).toHaveLength(2);
		for (const operation of operations())
			expect(operation).toMatchObject({
				expectedEffectCount: 0,
				effectOutcome: "no_change",
				settlement: "settled",
			});
		expect(effects()).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe("same");
		await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("no-dispatch journal rejection is not reported as a no-change fact", async () => {
		const path = join(workspace, "failed-no-dispatch.txt");
		await writeFile(path, "same");
		sqlite.exec(
			"CREATE TRIGGER fail_zero BEFORE INSERT ON file_change_operations BEGIN SELECT RAISE(ABORT, 'zero-journal-fault'); END",
		);
		const result = await edit(path, "missing", "replacement");
		expect(result.isError).toBe(true);
		expect(result.output).toContain("zero-journal-fault");
		expect(operations()).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe("same");
	});

	test("quota refusal and prepare failure occur before target IO", async () => {
		const path = join(workspace, "quota.txt");
		await writeFile(path, "old");
		runtime = makeRuntime({ quotaBytes: 3 });
		const apply = spyOn(io, "apply");
		expect((await write(path, "new")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(apply).not.toHaveBeenCalled();
		const namespace = await runtime.initialize();
		db.update(schema.fileChangeStorageBudgets).set({ quotaBytes: 1024 }).run();
		expect(namespace.catalog.getBudget()?.status).toBe("ready");
		sqlite.exec(
			"CREATE TRIGGER fail_prepare BEFORE INSERT ON file_change_effects BEGIN SELECT RAISE(ABORT, 'prepare-fault'); END",
		);
		expect((await write(path, "new")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(apply).not.toHaveBeenCalled();
		expect(operations()[0]).toMatchObject({
			settlement: "settled",
			executionOutcome: "failed",
			reason: "no_dispatch:validation_rejected",
		});
	});

	test("attribution linkage admission failure also leaves target unchanged", async () => {
		const path = join(workspace, "link.txt");
		await writeFile(path, "old");
		sqlite.exec(
			"CREATE TRIGGER fail_link BEFORE UPDATE OF file_change_operation_id ON narrator_tool_calls BEGIN SELECT RAISE(ABORT, 'link-fault'); END",
		);
		expect((await write(path, "new")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(effects()).toHaveLength(0);
	});

	test("content drift between prepare and dispatch never overwrites the human write", async () => {
		const path = join(workspace, "drift.txt");
		await writeFile(path, "old");
		io.apply = async (input) => {
			await writeFile(path, "human");
			return fileChangeLocalIo.apply(input);
		};
		expect((await write(path, "new")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("human");
		expect(effects()[0]).toMatchObject({
			outcome: "no_change",
			settlement: "settled",
			executionReceiptJson: { outcome: "not_applied", confirmed: true },
		});
		expect(attributions()).toHaveLength(0);
	});

	test("rename-and-replace during final guard never truncates the moved original or replacement", async () => {
		const path = join(workspace, "final-guard.txt");
		const moved = join(workspace, "moved-original.txt");
		await writeFile(path, "original bytes\n");
		let guards = 0;
		let dispatches = 0;
		io.apply = async (input) =>
			fileChangeLocalIo.apply({
				...input,
				async assertTarget() {
					await input.assertTarget();
					if (++guards === 2) {
						await rename(path, moved);
						await writeFile(path, "human replacement\n");
					}
				},
				onDispatch() {
					dispatches++;
					input.onDispatch();
				},
			});
		const result = await edit(path, "original", "agent");
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Opened object no longer matches the target before dispatch");
		expect(dispatches).toBe(0);
		expect(await readFile(moved, "utf8")).toBe("original bytes\n");
		expect(await readFile(path, "utf8")).toBe("human replacement\n");
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			outcome: "no_change",
			executionReceiptJson: { confirmed: true, outcome: "not_applied" },
		});
		expect(operations()[0].executionOutcome).toBe("failed");
		expect(attributions()).toHaveLength(0);
	});

	test("IO and runtime verification failures both reach the tool result without releasing the lease", async () => {
		const path = join(workspace, "two-observation-failures.txt");
		await writeFile(path, "old");
		const context = await callContext("Edit", path);
		const first = new DOMException("The operation timed out.", "TimeoutError");
		const second = Object.assign(new Error("private secondary message"), { code: "EIO" });
		let reads = 0;
		io.read = async (...args) => {
			reads++;
			if (reads === 3) throw first;
			if (reads === 4) throw second;
			return fileChangeLocalIo.read(...args);
		};
		const apply = spyOn(io, "apply");
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await edit(path, "old", "new", context);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("The operation timed out.");
			expect(result.output).toContain("io_final_read(TimeoutError), after_read(EIO)");
			expect(result.output).not.toContain("private secondary message");
			const trace = result.metadata?.fileChangeDiagnostics as FileChangeDiagnosticSnapshot;
			const operation = operations()[0];
			const lease = db.select().from(schema.workspaceWriteLeases).get();
			expect(trace).toMatchObject({
				version: 1,
				sourceId: context.toolCallBinding?.toolCallId,
				operationId: operation.id,
				leaseId: lease?.leaseId,
				failures: [
					{ stage: "io_final_read", name: "TimeoutError" },
					{ stage: "after_read", name: "Error", code: "EIO" },
				],
			});
			expect(trace.phases.find((phase) => phase.stage === "io_sync")).toBeDefined();
			expect(trace.phases.every((phase) => phase.elapsedMs >= 0)).toBe(true);
			expect(warning).toHaveBeenCalledWith("Local file-change operation failed", {
				sourceKind: "tool",
				diagnostics: trace,
			});
			expect(JSON.stringify(trace)).not.toContain(path);
			expect(JSON.stringify(trace)).not.toContain("private secondary message");
			expect(await readFile(path, "utf8")).toBe("new");
			expect(operation).toMatchObject({
				executionOutcome: "failed",
				settlement: "reconcile_required",
			});
			expect(effects()[0]).toMatchObject({
				outcome: "unknown",
				settlement: "reconcile_required",
				executionReceiptJson: { outcome: "unknown", confirmed: false },
			});
			expect(lease?.status).toBe("quarantined");
			expect((await edit(path, "new", "later")).output).toContain("needs verification");
			expect(apply).toHaveBeenCalledTimes(1);
			expect(await readFile(path, "utf8")).toBe("new");
		} finally {
			warning.mockRestore();
			apply.mockRestore();
		}
	});

	test("a runtime-only after-read timeout is distinct from the IO final check", async () => {
		const path = join(workspace, "runtime-read-timeout.txt");
		await writeFile(path, "old");
		let reads = 0;
		io.read = async (...args) => {
			if (++reads === 4) throw new DOMException("The operation timed out.", "TimeoutError");
			return fileChangeLocalIo.read(...args);
		};
		const result = await write(path, "new");
		const trace = result.metadata?.fileChangeDiagnostics as FileChangeDiagnosticSnapshot;
		expect(result.isError).toBe(true);
		expect(trace.failures).toEqual([{ stage: "after_read", name: "TimeoutError" }]);
		expect(effects()[0]).toMatchObject({
			settlement: "reconcile_required",
			executionReceiptJson: { outcome: "applied", confirmed: true },
		});
		expect(await readFile(path, "utf8")).toBe("new");
	});

	test("preparation failure survives a second no-dispatch settlement failure in diagnostics", async () => {
		const path = join(workspace, "preparation-double-failure.txt");
		await writeFile(path, "old");
		const evidence = new FileChangeEvidenceService(db);
		const prepare = spyOn(evidence, "finalizePreparation").mockImplementation(async () => {
			throw Object.assign(new Error("prepare failed"), { code: "EIO" });
		});
		const settle = spyOn(evidence, "finishPreparationWithoutDispatch").mockImplementation(() => {
			throw Object.assign(new Error("settlement failed"), { code: "SQLITE_CONSTRAINT" });
		});
		runtime = makeRuntime({ evidence });
		const apply = spyOn(io, "apply");
		try {
			const result = await edit(path, "old", "new");
			const trace = result.metadata?.fileChangeDiagnostics as FileChangeDiagnosticSnapshot;
			expect(result.isError).toBe(true);
			// Preserve the pre-existing outward error while retaining the original cause in the trace.
			expect(result.output).toContain("settlement failed");
			expect(trace.failures).toEqual([
				{ stage: "prepare_evidence", name: "Error", code: "EIO" },
				{ stage: "settle_evidence", name: "Error", code: "SQLITE_CONSTRAINT" },
			]);
			expect(apply).not.toHaveBeenCalled();
			expect(await readFile(path, "utf8")).toBe("old");
			expect(db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("quarantined");
		} finally {
			prepare.mockRestore();
			settle.mockRestore();
			apply.mockRestore();
		}
	});

	test("a primitive caller cancellation reason is rethrown unchanged after confirmed IO", async () => {
		const path = join(workspace, "primitive-cancel.txt");
		await writeFile(path, "old");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		io.apply = async (input) => {
			const result = await fileChangeLocalIo.apply(input);
			controller.abort("cancelled");
			return result;
		};
		await expect(
			runtime.execute({
				ctx: context,
				backend: localBackend,
				toolName: "Write",
				filePath: path,
				input: { content: "new" },
				construct: () => ({
					nextBytes: Buffer.from("new"),
					lineStats: null,
					result: { output: "written" },
				}),
			}),
		).rejects.toBe("cancelled");
		expect(await readFile(path, "utf8")).toBe("new");
		expect(operations()[0]).toMatchObject({
			executionOutcome: "interrupted",
			settlement: "settled",
		});
		expect(effects()[0]).toMatchObject({
			executionReceiptJson: { outcome: "applied", confirmed: true },
		});
		expect(db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("settled");
	});
	test("an adapter rejection has its own phase and never implies no dispatch", async () => {
		const path = join(workspace, "adapter-timeout.txt");
		await writeFile(path, "old");
		io.apply = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		const result = await write(path, "new");
		expect(result.output).toContain("apply_adapter(TimeoutError)");
		expect(effects()[0]).toMatchObject({
			settlement: "reconcile_required",
			executionReceiptJson: { outcome: "unknown", confirmed: false },
		});
		expect(await readFile(path, "utf8")).toBe("old");
	});

	test("observed-blob publication failure preserves an earlier IO verification failure", async () => {
		const path = join(workspace, "publication-timeout.txt");
		await writeFile(path, "old");
		const { store } = await runtime.initialize();
		const putBytes = store.putBytes.bind(store);
		const publish = spyOn(store, "putBytes").mockImplementation(async (bytes, options) => {
			if (Buffer.from(bytes).toString() === "foreign")
				throw Object.assign(new Error("publication failed"), { code: "ENOSPC" });
			return putBytes(bytes, options);
		});
		let reads = 0;
		io.read = async (...args) => {
			if (++reads === 3) throw new DOMException("The operation timed out.", "TimeoutError");
			return fileChangeLocalIo.read(...args);
		};
		io.apply = async (input) => {
			const result = await fileChangeLocalIo.apply.call(io, input);
			await writeFile(path, "foreign");
			return result;
		};
		try {
			const result = await write(path, "new");
			const trace = result.metadata?.fileChangeDiagnostics as FileChangeDiagnosticSnapshot;
			expect(result.isError).toBe(true);
			expect(trace.failures).toEqual([
				{ stage: "io_final_read", name: "TimeoutError" },
				{ stage: "publish_observed", name: "Error", code: "ENOSPC" },
			]);
			expect(db.select().from(schema.workspaceWriteLeases).get()?.status).toBe("quarantined");
			expect(await readFile(path, "utf8")).toBe("foreign");
		} finally {
			publish.mockRestore();
		}
	});
	test("after mismatch is an actual applied-but-unknown result, not success or rollback", async () => {
		const path = join(workspace, "after.txt");
		await writeFile(path, "old");
		io.apply = async (input) => {
			const result = await fileChangeLocalIo.apply(input);
			await writeFile(path, "external-after");
			return result;
		};
		const result = await write(path, "new");
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("external-after");
		expect(effects()[0]).toMatchObject({
			settlement: "reconcile_required",
			outcome: "unknown",
			executionReceiptJson: { confirmed: true, outcome: "applied" },
		});
		expect(operations()[0].executionOutcome).toBe("failed");
		expect(pendingScope()).toMatchObject({ status: "active", activeLeaseId: null });
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
				.all(),
		).toHaveLength(1);
	});

	test("settlement DB failure keeps pending evidence/quarantine and never retries written IO", async () => {
		const path = join(workspace, "settle.txt");
		await writeFile(path, "old");
		const ctx = await callContext("Write", path);
		const apply = spyOn(io, "apply");
		sqlite.exec(
			"CREATE TRIGGER fail_settle BEFORE UPDATE OF execution_receipt_json ON file_change_effects BEGIN SELECT RAISE(ABORT, 'settlement-fault'); END",
		);
		const failed = await write(path, "new", ctx);
		expect(failed.isError).toBe(true);
		expect(failed.output).toContain("settle_evidence(");
		expect(await readFile(path, "utf8")).toBe("new");
		expect(effects()[0]).toMatchObject({ settlement: "applying", executionReceiptJson: null });
		expect(pendingScope()).toMatchObject({
			status: "active",
			activeMutationCount: 0,
			activeLeaseId: null,
		});
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
				.get(),
		).toMatchObject({
			mutationManifestJson: {
				version: 1,
				mutations: [
					{
						mutationId: effects()[0].mutationId,
						operationId: operations()[0].id,
						effectId: effects()[0].id,
						outcome: "pending",
					},
				],
			},
		});
		expect((await write(path, "new", ctx)).isError).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	test("operation finish DB failure rolls back effect receipt and lease settlement together", async () => {
		const path = join(workspace, "finish.txt");
		await writeFile(path, "old\n");
		sqlite.exec(
			"CREATE TRIGGER fail_finish BEFORE UPDATE OF execution_outcome ON file_change_operations WHEN NEW.execution_outcome = 'succeeded' BEGIN SELECT RAISE(ABORT, 'finish-fault'); END",
		);
		const result = await write(path, "new\n");
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(effects()[0]).toMatchObject({
			settlement: "applying",
			attributionGrade: "unknown",
			linesAdded: null,
			linesRemoved: null,
			executionReceiptJson: null,
		});
		expect(operations()[0].executionOutcome).toBe("running");
		expect(pendingScope()).toMatchObject({
			status: "active",
			activeMutationCount: 0,
			activeLeaseId: null,
		});
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
				.get(),
		).toMatchObject({
			mutationManifestJson: {
				version: 1,
				mutations: [
					{
						mutationId: effects()[0].mutationId,
						operationId: operations()[0].id,
						effectId: effects()[0].id,
						outcome: "pending",
					},
				],
			},
		});
	});

	test("wrong PK, legacy version, COW origin and target mismatch cannot enter v2", async () => {
		const path = join(workspace, "guard.txt");
		await writeFile(path, "old");
		for (const mutation of [
			{ executionIdentityVersion: 0 },
			{ executionOriginToolCallId: "cow-original" },
			{ executionAttempt: 2 },
			{ executionDeviceId: "remote" },
		]) {
			const ctx = await callContext("Write", path);
			db.update(schema.narratorToolCalls)
				.set(mutation)
				.where(eq(schema.narratorToolCalls.id, ctx.toolCallBinding?.toolCallId as string))
				.run();
			expect((await write(path, "new", ctx)).isError).toBe(true);
		}
		expect(await readFile(path, "utf8")).toBe("old");
		expect(operations()).toHaveLength(0);
		await expect(lstat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("application data directory compatibility", () => {
	test.skipIf(process.platform === "win32")(
		"real Write and Edit accept owner 0775 appdata protected by a 0700 home",
		async () => {
			await chmod(root, 0o700);
			await mkdir(privateRoot, { mode: 0o775 });
			await chmod(privateRoot, 0o775);
			const path = join(workspace, "existing-home.txt");
			const created = await write(path, "original\n");
			expect(created.isError).not.toBe(true);
			const edited = await edit(path, "original", "changed");
			expect(edited.isError).not.toBe(true);
			expect(await readFile(path, "utf8")).toBe("changed\n");
			expect((await lstat(privateRoot)).mode & 0o777).toBe(0o775);
			expect((await lstat(join(privateRoot, "file-change-blobs"))).mode & 0o777).toBe(0o700);
			expect((await lstat(join(privateRoot, "file-change-source.json"))).mode & 0o777).toBe(0o600);
			expect(effects()).toHaveLength(2);
			expect(effects().map((row) => row.settlement)).toEqual(["settled", "settled"]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a failed permission check is retriable in the same runtime without clearing evidence",
		async () => {
			await mkdir(privateRoot, { mode: 0o777 });
			await chmod(privateRoot, 0o777);
			await expect(runtime.initialize()).rejects.toThrow();
			expect(db.select().from(schema.fileChangeStorageBudgets).get()).toBeUndefined();
			await chmod(privateRoot, 0o775);
			const ready = await runtime.initialize();
			expect(ready.catalog.getBudget()?.status).toBe("ready");
			expect((await runtime.initialize()).sourceInstanceId).toBe(ready.sourceInstanceId);
		},
	);

	test.skipIf(process.platform === "win32")(
		"cached namespace rechecks a private ancestor before the next write",
		async () => {
			await mkdir(privateRoot, { mode: 0o775 });
			await chmod(privateRoot, 0o775);
			const initialized = await runtime.initialize();
			const path = join(workspace, "ancestor-permissions.txt");
			await writeFile(path, "human bytes");
			await chmod(root, 0o755);
			expect((await write(path, "must not write")).isError).toBe(true);
			expect(await readFile(path, "utf8")).toBe("human bytes");
			expect(operations()).toHaveLength(0);
			await chmod(root, 0o700);
			expect((await edit(path, "human", "agent")).isError).not.toBe(true);
			expect((await runtime.initialize()).sourceInstanceId).toBe(initialized.sourceInstanceId);
		},
	);

	test.skipIf(process.platform === "win32")(
		"sticky appdata is not a substitute for a private ancestor",
		async () => {
			await chmod(root, 0o755);
			await mkdir(privateRoot, { mode: 0o775 });
			await chmod(privateRoot, 0o1775);
			await expect(runtime.initialize()).rejects.toThrow("private ancestor");
			expect(db.select().from(schema.fileChangeStorageBudgets).get()).toBeUndefined();
		},
	);

	test.skipIf(process.platform === "win32")(
		"permissive blob storage is still rejected without chmod or replacement",
		async () => {
			const blobs = join(privateRoot, "file-change-blobs");
			await mkdir(blobs, { recursive: true, mode: 0o700 });
			await chmod(blobs, 0o775);
			await expect(runtime.initialize()).rejects.toThrow("owned private (0700)");
			expect((await lstat(blobs)).mode & 0o777).toBe(0o775);
			expect(db.select().from(schema.fileChangeStorageBudgets).get()).toBeUndefined();
		},
	);

	for (const damage of ["missing", "corrupt"] as const) {
		test(`real Write survives ${damage} identity with stable coordination and rejects old history`, async () => {
			await write(join(workspace, "old.txt"), "old evidence");
			const oldScope = db.select().from(schema.fileChangeScopes).get();
			const identityPath = join(privateRoot, "file-change-source.json");
			if (damage === "missing") await rm(identityPath);
			else await writeFile(identityPath, "{broken");
			// A new DB wrapper simulates losing runtime caches while retaining durable scopes.
			db = database(sqlite);
			runtime = makeRuntime();
			const apply = spyOn(io, "apply");
			const path = join(workspace, "after-damage.txt");
			const ctx = await callContext("Write", path);
			const result = await write(path, "still written", ctx);
			expect(result.isError).not.toBe(true);
			expect(result.metadata?.fileChangeHistoryUnavailable).toBe(true);
			expect(result.metadata?.fileChangeEvidence).toBeUndefined();
			expect(await readFile(path, "utf8")).toBe("still written");
			expect((await write(path, "no replay", ctx)).isError).toBe(true);
			expect(apply).toHaveBeenCalledTimes(1);
			const scopes = db.select().from(schema.fileChangeScopes).all();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({
				id: oldScope?.id,
				sourceInstanceId: oldScope?.sourceInstanceId,
				workspaceInstanceId: oldScope?.workspaceInstanceId,
			});
			await expect(runtime.verifyNamespace()).rejects.toThrow();
			await runtime.initialize().catch(() => {});
			await runtime.initialize().catch(() => {});
			expect(effects()).toHaveLength(1);
		});
	}

	test("cold empty-history fallback keeps one durable coordination identity across runtimes", async () => {
		await runtime.initialize();
		await rm(join(privateRoot, "file-change-source.json"));
		db = database(sqlite);
		runtime = makeRuntime();
		const first = await write(join(workspace, "first-fallback.txt"), "first");
		expect(first.isError).not.toBe(true);
		expect(first.metadata?.fileChangeHistoryUnavailable).toBe(true);
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
		const firstScope = db.select().from(schema.fileChangeScopes).get();
		if (!firstScope) throw new Error("Expected durable fallback scope");
		db = database(sqlite);
		runtime = makeRuntime();
		const second = await write(join(workspace, "second-fallback.txt"), "second");
		expect(second.isError).not.toBe(true);
		expect(second.metadata?.fileChangeHistoryUnavailable).toBe(true);
		const scopes = db.select().from(schema.fileChangeScopes).all();
		expect(scopes).toHaveLength(1);
		expect(scopes[0]?.id).toBe(firstScope.id);
		expect(scopes[0]?.sourceInstanceId).toBe(firstScope.sourceInstanceId);
		await expect(runtime.verifyNamespace()).rejects.toThrow();
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
	});

	test("directory replaced after io.read resets before dispatch and records this operation", async () => {
		await write(join(workspace, "old.txt"), "retained evidence");
		const budget = db.select().from(schema.fileChangeStorageBudgets).get();
		const blobs = join(privateRoot, "file-change-blobs");
		let replaced = false;
		io.read = async (...args) => {
			const observed = await fileChangeLocalIo.read(...args);
			if (!replaced) {
				replaced = true;
				await rename(blobs, join(privateRoot, "retained-blobs"));
				await mkdir(blobs, { mode: 0o700 });
			}
			return observed;
		};
		const apply = spyOn(io, "apply");
		const path = join(workspace, "replaced-after-read.txt");
		const ctx = await callContext("Write", path);
		const result = await write(path, "one dispatch", ctx);
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(await readFile(path, "utf8")).toBe("one dispatch");
		expect(apply).toHaveBeenCalledTimes(1);
		expect((await write(path, "no replay", ctx)).isError).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
		expect(db.select().from(schema.fileChangeStorageBudgets).get()?.namespaceKey).not.toBe(
			budget?.namespaceKey,
		);
		expect(db.select().from(schema.fileChangeStorageBudgets).get()?.status).toBe("ready");
		expect(effects()).toHaveLength(2);
		expect(operations()).toHaveLength(2);
	});

	test("missing old blobs allow writes without silently trusting old history", async () => {
		await write(join(workspace, "old.txt"), "retained history");
		const budget = db.select().from(schema.fileChangeStorageBudgets).get();
		const blobs = join(privateRoot, "file-change-blobs");
		await rename(blobs, join(privateRoot, "retained-blobs"));
		await mkdir(blobs, { mode: 0o700 });
		const path = join(workspace, "changed-namespace.txt");
		const ctx = await callContext("Write", path);
		const apply = spyOn(io, "apply");
		const result = await write(path, "tool still works", ctx);
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.fileChangeHistoryUnavailable).toBeUndefined();
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(await readFile(path, "utf8")).toBe("tool still works");
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
		expect((await write(path, "do not redispatch", ctx)).isError).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
		await runtime.verifyNamespace();
		const after = db.select().from(schema.fileChangeStorageBudgets).get();
		expect(after?.namespaceKey).not.toBe(budget?.namespaceKey);
		expect(after?.status).toBe("ready");
		expect(effects()).toHaveLength(2);
		expect(effects()[0].observedAfterStateJson).toEqual({ kind: "unknown", reason: "expired" });
		expect(operations()).toHaveLength(2);
	});

	test("concurrent initialization resets a copied namespace once and invalidates old refs", async () => {
		await write(join(workspace, "original.txt"), "original bytes");
		const original = await runtime.initialize();
		const budget = original.catalog.getBudget();
		const copied = join(root, "copied-private");
		await cp(privateRoot, copied, { recursive: true });
		runtime = makeRuntime({ privateRoot: copied });
		const initialize = Array.from({ length: 8 }, () => runtime.initialize().catch(() => {}));
		await Promise.all(initialize);
		await runtime.initialize().catch(() => {});
		const recovered = await runtime.verifyNamespace();
		expect(recovered.sourceInstanceId).toBe(original.sourceInstanceId);
		const after = recovered.catalog.getBudget();
		expect(after?.namespaceKey).not.toBe(budget?.namespaceKey);
		expect(after?.generation).toBe((budget?.generation ?? 0) + 1);
		expect(after?.status).toBe("ready");
		expect(after?.usedBytes).toBe(0);
		expect(after?.reservedBytes).toBe(budget?.reservedBytes);
		expect(after?.quotaBytes).toBe(budget?.quotaBytes);
		expect(db.select().from(schema.fileChangeBlobReservations).all()).toEqual([]);
		expect(effects()).toHaveLength(1);
		expect(() => original.catalog.getBudget()).toThrow();
		expect(
			(await write(join(workspace, "new.txt"), "new bytes")).metadata?.fileChangeEvidence,
		).toBeDefined();
	});

	test("corrupt copied content is discarded without inventory hashing and Edit records new evidence", async () => {
		const path = join(workspace, "editable.txt");
		await write(path, "before");
		const copied = join(root, "corrupt-copy");
		await cp(privateRoot, copied, { recursive: true });
		const blob = db.select().from(schema.fileChangeBlobs).get();
		if (!blob) throw new Error("Expected published blob");
		await writeFile(join(copied, "file-change-blobs", blob.storageKey), "broken");
		runtime = makeRuntime({ privateRoot: copied });
		const apply = spyOn(io, "apply");
		const result = await edit(path, "before", "after");
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(await readFile(path, "utf8")).toBe("after");
		expect(apply).toHaveBeenCalledTimes(1);
		expect((await runtime.verifyNamespace()).catalog.getBudget()?.status).toBe("ready");
		const old = effects()[0];
		expect(old.observedAfterStateJson).toEqual({ kind: "unknown", reason: "expired" });
		// Publishing the identical digest again must not resurrect the old reference.
		expect((await edit(path, "after", "before")).isError).not.toBe(true);
		expect(effects()[0].observedAfterStateJson).toEqual({ kind: "unknown", reason: "expired" });
	});

	test("namespace reset discards old reservations without stopping coordinated Bash", async () => {
		const namespace = await runtime.initialize();
		namespace.catalog.reserve({
			expectedGeneration: namespace.generation,
			ownerEpoch: "old-owner",
			expectedSize: 17,
			signal: new AbortController().signal,
		});
		const copied = join(root, "reserved-copy");
		await cp(privateRoot, copied, { recursive: true });
		runtime = makeRuntime({ privateRoot: copied });
		const activity = await runtime.registerBashActivity({
			backend: localBackend,
			cwd: workspace,
			signal: new AbortController().signal,
		});
		expect(runtime.coordinator.capture(activity.scope).active.uncoordinatedActivities).toBe(1);
		const binding = localFileChangeRuntimeBinding();
		if (!binding) throw new Error("Expected local runtime");
		await expect(
			runtime.coordinator.withRollback(
				{
					scope: activity.scope,
					runtime: binding,
					signal: new AbortController().signal,
					waitTimeoutMs: 20,
				},
				async () => {},
			),
		).rejects.toThrow();
		activity.end("finished");
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
		expect(db.select().from(schema.fileChangeBlobReservations).all()).toEqual([]);
		expect(db.select().from(schema.fileChangeStorageBudgets).get()?.reservedBytes).toBe(0);
		await expect(
			runtime.coordinator.withRollback(
				{
					scope: activity.scope,
					runtime: binding,
					signal: new AbortController().signal,
				},
				async () => "allowed",
			),
		).resolves.toBe("allowed");
	});

	test("StructSed still applies a single guarded mutation with missing blob history", async () => {
		const path = join(workspace, "struct.txt");
		await write(path, "first\nsecond\n");
		const blobs = join(privateRoot, "file-change-blobs");
		await rename(blobs, join(privateRoot, "struct-retained-blobs"));
		await mkdir(blobs, { mode: 0o700 });
		const ctx = await callContext("StructSed", path);
		const apply = spyOn(io, "apply");
		const result = await withLocalFileChangeRuntime(runtime, () =>
			structSedTool.execute(
				{
					file_path: path,
					command: "replace",
					address: "2",
					content: "changed",
					dry_run: false,
				},
				ctx,
			),
		);
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await readFile(path, "utf8")).toBe("first\nchanged\n");
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
	});

	test("namespace fence at publication falls back only before IO", async () => {
		const namespace = await runtime.initialize();
		const read = io.read;
		let fenced = false;
		io.read = async (...args) => {
			const value = await read(...args);
			if (!fenced) {
				fenced = true;
				namespace.catalog.beginReconciliation({ expectedGeneration: namespace.generation });
			}
			return value;
		};
		const apply = spyOn(io, "apply");
		const path = join(workspace, "fenced-before.txt");
		const result = await write(path, "once");
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await readFile(path, "utf8")).toBe("once");
		await runtime.initialize().catch(() => {});
		await runtime.initialize().catch(() => {});
	});

	test("namespace loss after target dispatch never retries the actual write", async () => {
		const apply = io.apply.bind(io);
		let calls = 0;
		io.apply = async (...args) => {
			calls++;
			const execution = await apply(...args);
			const blobs = join(privateRoot, "file-change-blobs");
			await rename(blobs, join(privateRoot, "after-dispatch-blobs"));
			await mkdir(blobs, { mode: 0o700 });
			return execution;
		};
		const path = join(workspace, "lost-after.txt");
		const result = await write(path, "only once");
		expect(result.isError).toBe(true);
		expect(calls).toBe(1);
		expect(await readFile(path, "utf8")).toBe("only once");
		expect(operations()).toHaveLength(1);
		expect(effects()).toHaveLength(1);
	});

	test("interrupted cache metadata reset stays fenced and retries without losing new evidence", async () => {
		const path = join(workspace, "retry-reset.txt");
		await write(path, "before");
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		sqlite.exec(
			"CREATE TRIGGER fail_reset BEFORE UPDATE ON file_change_effects BEGIN SELECT RAISE(ABORT, 'interrupted reset'); END",
		);
		runtime = makeRuntime();
		await expect(runtime.initialize()).rejects.toThrow("UPDATE file_change_effects");
		expect(db.select().from(schema.fileChangeStorageBudgets).get()?.status).toBe("unverified");
		sqlite.exec("DROP TRIGGER fail_reset");
		const result = await edit(path, "before", "after");
		expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect(effects()[0].observedAfterStateJson).toEqual({ kind: "unknown", reason: "expired" });
		expect(effects()[1].beforeStateJson.kind).toBe("regular");
		expect((await runtime.verifyNamespace()).catalog.getBudget()?.status).toBe("ready");
	});

	test("concurrent first writes after directory removal share one reset and keep every receipt", async () => {
		await write(join(workspace, "old.txt"), "old");
		const generation = (await runtime.initialize()).generation;
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		const results = await Promise.all(
			Array.from({ length: 4 }, (_, i) => write(join(workspace, `parallel-${i}.txt`), `body-${i}`)),
		);
		for (const result of results) expect(result.metadata?.fileChangeEvidence).toBeDefined();
		expect((await runtime.verifyNamespace()).generation).toBe(generation + 1);
		expect(effects()).toHaveLength(5);
		for (const effect of effects().slice(1))
			expect(effect.observedAfterStateJson.kind).toBe("regular");
	});

	test("namespace reset waits until the entire in-flight cache consumer settles", async () => {
		await write(join(workspace, "old.txt"), "old");
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const started = new Promise<void>((done) => {
			entered = done;
		});
		const active = runtime.withNamespaceAccess(async () => {
			entered();
			await gate;
		});
		await started;
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		let resetFinished = false;
		const fresh = makeRuntime();
		const reset = fresh.initialize().then(() => {
			resetFinished = true;
		});
		await Bun.sleep(15);
		expect(resetFinished).toBe(false);
		release();
		await active;
		await reset;
		expect(resetFinished).toBe(true);
	});

	test("hot reload drains and retires the old verifier before resetting", async () => {
		await write(join(workspace, "old.txt"), "old");
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		const jobs = hotSafe(
			"narrafork.file-change-namespace-recovery.v1",
			() => new WeakMap<object, { pending?: Promise<void>; retryAfter: number }>(),
		);
		let release!: () => void;
		const pending = new Promise<void>((done) => {
			release = done;
		});
		const state = { pending, retryAfter: 0 };
		jobs.set(db, state);
		let ready = false;
		const fresh = makeRuntime();
		const reset = fresh.initialize().then(() => {
			ready = true;
		});
		await Bun.sleep(15);
		expect(ready).toBe(false);
		release();
		await reset;
		expect(ready).toBe(true);
		expect(state.retryAfter).toBe(Number.POSITIVE_INFINITY);
	});

	test("loss of new cache bytes does not block a future mutation", async () => {
		const path = join(workspace, "lost-new-bytes.txt");
		await write(path, "old");
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		expect((await edit(path, "old", "new")).metadata?.fileChangeEvidence).toBeDefined();
		const ns = await runtime.verifyNamespace();
		await rm(join(privateRoot, "file-change-blobs"), { recursive: true, force: true });
		expect((await edit(path, "new", "later")).metadata?.fileChangeEvidence).toBeDefined();
		expect((await runtime.verifyNamespace()).generation).toBeGreaterThan(ns.generation);
		expect(await readFile(path, "utf8")).toBe("later");
	});

	test("source and catalog identity survive a fresh service under the same appdata", async () => {
		const path = join(workspace, "retain-identity.txt");
		expect((await write(path, "before")).isError).not.toBe(true);
		const first = await runtime.initialize();
		const before = first.catalog.getBudget();
		runtime = makeRuntime();
		const fresh = await runtime.initialize();
		expect(fresh.sourceInstanceId).toBe(first.sourceInstanceId);
		expect(fresh.catalog.getBudget()).toEqual(before);
		expect((await edit(path, "before", "after")).isError).not.toBe(true);
		expect(effects()).toHaveLength(2);
	});

	test.skipIf(process.platform === "win32")(
		"a group-writable appdata without a private ancestor remains rejected",
		async () => {
			await chmod(root, 0o755);
			await mkdir(privateRoot, { mode: 0o775 });
			await chmod(privateRoot, 0o775);
			const path = join(workspace, "unsafe-parent.txt");
			expect((await write(path, "must not write")).isError).toBe(true);
			await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
			expect(operations()).toHaveLength(0);
		},
	);
});

describe("legacy workspace lock interoperability", () => {
	function bashInput() {
		return {
			cwd: `${workspace}/./`,
			filePaths: [],
			hasWriteOperation: true,
			allReadOnly: false,
			isBackground: false,
		};
	}

	function observeLegacyWaiter() {
		const requested = deferred();
		const acquire = worktreeWriteLock.acquire.bind(worktreeWriteLock);
		const spy = spyOn(worktreeWriteLock, "acquire").mockImplementation((key, fn) => {
			requested.resolve();
			return acquire(key, fn);
		});
		return { requested: requested.promise, restore: () => spy.mockRestore() };
	}

	for (const tool of ["Write", "Edit"] as const) {
		test(`Bash's old lock blocks v2 ${tool} before capture, including normalized cwd`, async () => {
			const path = join(workspace, "shared.txt");
			await writeFile(path, "original");
			const gate = deferred();
			const entered = deferred();
			const bash = withBashWriteLock(localBackend, bashInput(), async () => {
				entered.resolve();
				await gate.promise;
				await writeFile(path, "bash");
			});
			await entered.promise;
			const waiter = observeLegacyWaiter();
			const read = spyOn(io, "read");
			const pending = tool === "Write" ? write(path, "v2") : edit(path, "bash", "v2");
			try {
				await Promise.race([
					waiter.requested,
					pending.then(() => {
						throw new Error("v2 bypassed the legacy workspace lock");
					}),
				]);
				expect(read).not.toHaveBeenCalled();
				expect(operations()).toHaveLength(0);
			} finally {
				waiter.restore();
				gate.resolve();
				await Promise.all([bash, pending]);
				read.mockRestore();
			}
			expect((await bash).serialized).toBe(true);
			expect((await pending).isError).toBeUndefined();
			expect(await readFile(path, "utf8")).toBe("v2");
			expect(await bytesFor(effects()[0].beforeStateJson)).toEqual(Buffer.from("bash"));
			expect(effects()[0]).toMatchObject({ attributionGrade: "measured", settlement: "settled" });
		});
	}

	for (const outcome of ["success", "error", "abort"] as const) {
		test(`v2 holds Bash's old lock through receipt settlement and releases on ${outcome}`, async () => {
			const path = join(workspace, "reverse.txt");
			await writeFile(path, "original");
			const gate = deferred();
			const entered = deferred();
			io.apply = async (input) => {
				entered.resolve();
				await gate.promise;
				if (outcome === "error")
					return {
						kind: "not_applied",
						error: new Error("injected pre-dispatch error"),
						parentEffects: { createdPaths: [], possiblePaths: [] },
					};
				return fileChangeLocalIo.apply(input);
			};
			const ctx = await callContext("Write", path);
			const controller = new AbortController();
			ctx.signal = controller.signal;
			let finished = false;
			const pending = write(path, "v2", ctx).then((result) => {
				finished = true;
				return result;
			});
			await entered.promise;
			if (outcome === "abort") controller.abort(new Error("cancel during IO"));
			let bashEntered = false;
			const bash = withBashWriteLock(localBackend, bashInput(), async () => {
				bashEntered = true;
				expect(effects()[0].settlement).toBe("settled");
				await writeFile(path, `${await readFile(path, "utf8")}+bash`);
			});
			try {
				await Promise.resolve();
				expect(finished).toBe(false);
				expect(bashEntered).toBe(false);
			} finally {
				gate.resolve();
				await Promise.all([pending, bash]);
			}
			expect((await pending).isError).toBe(outcome === "success" ? undefined : true);
			expect((await bash).serialized).toBe(true);
			expect(await readFile(path, "utf8")).toBe(
				`${outcome === "success" ? "v2" : "original"}+bash`,
			);
		});
	}

	test("cancelled v2 admission drains without IO and never unlocks the Bash holder early", async () => {
		const path = join(workspace, "cancel-legacy.txt");
		await writeFile(path, "original");
		const gate = deferred();
		const entered = deferred();
		const bash = withBashWriteLock(localBackend, bashInput(), async () => {
			entered.resolve();
			await gate.promise;
		});
		await entered.promise;
		const waiter = observeLegacyWaiter();
		const ctx = await callContext("Write", path);
		const controller = new AbortController();
		ctx.signal = controller.signal;
		const pending = write(path, "cancelled", ctx);
		let followerEntered = false;
		let follower: Promise<void> | undefined;
		try {
			await Promise.race([
				waiter.requested,
				pending.then(() => {
					throw new Error("v2 bypassed the legacy workspace lock");
				}),
			]);
			controller.abort(new Error("cancel while waiting for Bash"));
			expect((await pending).isError).toBe(true);
			expect(operations()).toHaveLength(0);
			expect(pendingScope()?.activeMutationCount).toBe(0);
			follower = withWorkspaceWriteLock(localBackend, workspace, async () => {
				followerEntered = true;
			});
			await Promise.resolve();
			expect(followerEntered).toBe(false);
			expect(await readFile(path, "utf8")).toBe("original");
		} finally {
			waiter.restore();
			gate.resolve();
			await Promise.all([bash, pending, follower]);
		}
		expect(followerEntered).toBe(true);
		expect((await write(path, "next")).isError).toBeUndefined();
		expect(effects()).toHaveLength(1);
	});

	test("editor shares the legacy cwd lock even when its evidence root resolves a symlink", async () => {
		const path = join(workspace, "editor.txt");
		await writeFile(path, "original");
		const alias = join(root, "workspace-alias");
		await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
		const userId = generateId();
		db.insert(schema.users)
			.values({
				id: userId,
				username: userId,
				passwordHash: "test",
				role: "user",
				createdAt: new Date().toISOString(),
			})
			.run();
		const gate = deferred();
		const entered = deferred();
		const bash = withBashWriteLock(localBackend, { ...bashInput(), cwd: alias }, async () => {
			entered.resolve();
			await gate.promise;
			await writeFile(path, "bash");
		});
		await entered.promise;
		const waiter = observeLegacyWaiter();
		let captured: string | undefined;
		const pending = runtime.executeEditor({
			requestId: generateId(),
			userId,
			narratorId,
			cwd: alias,
			lexicalPath: path,
			canonicalPath: path,
			signal: new AbortController().signal,
			input: { content: "editor" },
			authorize: async () => {},
			construct(before) {
				captured = Buffer.from(before.bytes ?? []).toString();
				return { nextBytes: Buffer.from("editor"), result: "saved", lineStats: null };
			},
		});
		try {
			await Promise.race([
				waiter.requested,
				pending.then(() => {
					throw new Error("editor bypassed the legacy workspace lock");
				}),
			]);
			expect(captured).toBeUndefined();
		} finally {
			waiter.restore();
			gate.resolve();
			await Promise.all([bash, pending]);
		}
		expect(captured).toBe("bash");
		expect((await pending).fileChangeEvidence).toMatchObject({ version: 2, settlement: "settled" });
		expect(await readFile(path, "utf8")).toBe("editor");
		expect(pendingScope()?.canonicalRoot).toBe(workspace);
	});

	test("nested v2 calls still fail coordinator admission instead of deadlocking on the old mutex", async () => {
		const path = join(workspace, "nested.txt");
		await writeFile(path, "original");
		io.apply = async (input) => {
			const nested = await write(path, "nested");
			expect(nested.isError).toBe(true);
			expect(nested.output).toContain("Nested");
			return fileChangeLocalIo.apply(input);
		};
		expect((await write(path, "outer")).isError).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("outer");
		expect(effects()).toHaveLength(1);
	});
});

describe("lazy namespace, coordination and cancellation", () => {
	test("construction is lazy; source instance persists but remote runtime is never guessed", async () => {
		await expect(lstat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
		const first = await runtime.initialize();
		const next = makeRuntime();
		expect((await next.initialize()).sourceInstanceId).toBe(first.sourceInstanceId);
		expect(localFileChangeRuntimeBinding()).toBe(localFileChangeRuntimeBinding());
		expect(localFileChangeRuntimeBinding("remote")).toBeNull();
	});

	test("nonempty unverified namespace is refused, never marked ready by an imaginary worker", async () => {
		await mkdir(join(privateRoot, "file-change-blobs"), { recursive: true, mode: 0o700 });
		await writeFile(join(privateRoot, "file-change-blobs", "unknown"), "old evidence");
		await expect(runtime.initialize()).rejects.toThrow("Nonempty blob namespace");
		expect(db.select().from(schema.fileChangeStorageBudgets).get()).toBeUndefined();
	});

	test("ready catalog with an unfinished previous reservation cannot be reused", async () => {
		const initialized = await runtime.initialize();
		initialized.catalog.reserve({
			expectedGeneration: initialized.generation,
			ownerEpoch: "old-process",
			expectedSize: 0,
			signal: new AbortController().signal,
		});
		await expect(makeRuntime().initialize()).rejects.toThrow("Unfinished blob reservation");
	});

	test("concurrent actual tools capture serial before values under one coordinator", async () => {
		const path = join(workspace, "concurrent.txt");
		await writeFile(path, "one");
		const gate = deferred();
		const entered = deferred();
		let invocations = 0;
		io.apply = async (input) => {
			if (++invocations === 1) {
				entered.resolve();
				await gate.promise;
			}
			return fileChangeLocalIo.apply(input);
		};
		const first = write(path, "two");
		await entered.promise;
		const second = edit(path, "two", "three");
		gate.resolve();
		const results = await Promise.all([first, second]);
		expect(results.map((result) => result.isError)).toEqual([undefined, undefined]);
		expect(await readFile(path, "utf8")).toBe("three");
		expect(await bytesFor(effects()[1].beforeStateJson)).toEqual(Buffer.from("two"));
	});

	test("known co-writer does not downgrade an independently journaled write", async () => {
		const path = join(workspace, "ambiguous.txt");
		await writeFile(path, "one");
		io.apply = async (input) => {
			const scope = pendingScope();
			if (!scope) throw new Error("No lease scope");
			const activity = runtime.coordinator.registerActivity({
				scope,
				runtime: processRuntime(),
			});
			const result = await fileChangeLocalIo.apply(input);
			runtime.coordinator.endActivity(activity);
			return result;
		};
		const result = await write(path, "two");
		expect(result.isError).toBeUndefined();
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			attributionGrade: "measured",
			outcome: "changed",
			linesAdded: 1,
			linesRemoved: 1,
		});
		expect(operations()[0]).toMatchObject({ executionOutcome: "succeeded", settlement: "settled" });
		expect(result.metadata?.linesAdded).toBe(1);
	});

	test("later metadata activity cannot downgrade the frozen receipt grade/counts", async () => {
		const path = join(workspace, "frozen.txt");
		await writeFile(path, "one\n");
		const evidence = new FileChangeEvidenceService(db);
		const settle = evidence.settleEffect.bind(evidence);
		spyOn(evidence, "settleEffect").mockImplementation((input, tx) => {
			const result = settle(input, tx);
			const scope = pendingScope();
			if (!scope) throw new Error("No granted scope");
			const activity = runtime.coordinator.registerActivity({
				scope,
				runtime: processRuntime(),
			});
			runtime.coordinator.endActivity(activity);
			return result;
		});
		runtime = makeRuntime({ evidence });
		expect((await write(path, "two\n")).isError).toBeUndefined();
		expect(effects()[0]).toMatchObject({
			attributionGrade: "measured",
			linesAdded: 1,
			linesRemoved: 1,
		});
		expect(attributions()[0].attributionGrade).toBe("measured");
	});

	test("confirmed IO stays applied when cancellation interrupts the tool", async () => {
		const path = join(workspace, "completed-cancel.txt");
		await writeFile(path, "old\n");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		let count = 0;
		io.apply = async (input) => {
			count++;
			const result = await fileChangeLocalIo.apply(input);
			controller.abort(new Error("cancel after durable IO"));
			return result;
		};
		expect((await write(path, "new\n", context)).isError).toBe(true);
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			attributionGrade: "measured",
			executionReceiptJson: { confirmed: true, outcome: "applied" },
		});
		expect(operations()[0]).toMatchObject({
			settlement: "settled",
			executionOutcome: "interrupted",
		});
		expect(db.select().from(schema.workspaceWriteLeases).get()).toMatchObject({
			status: "settled",
			mutationManifestJson: { mutations: [{ outcome: "applied" }] },
		});
		expect((await write(path, "new\n", context)).isError).toBe(true);
		expect(count).toBe(1);
	});

	test("without blobs cancellation still settles confirmed IO and interrupts the tool", async () => {
		await runtime.initialize();
		await rm(join(privateRoot, "file-change-source.json"), { force: true });
		db = database(sqlite);
		runtime = makeRuntime();
		const path = join(workspace, "no-blobs-cancel.txt");
		await writeFile(path, "old");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		io.apply = async (input) => {
			const result = await fileChangeLocalIo.apply(input);
			controller.abort(new Error("cancel after durable IO"));
			return result;
		};
		const failed = await write(path, "new", context);
		expect(failed.isError).toBe(true);
		expect(failed.metadata?.fileChangeDiagnostics).toMatchObject({
			abortSource: "caller",
			operationId: operations()[0].id,
			failures: [{ stage: "verify_result", name: "Error" }],
		});
		expect(await readFile(path, "utf8")).toBe("new");
		expect(operations()[0].executionOutcome).toBe("interrupted");
		expect(effects()).toHaveLength(0);
		expect(db.select().from(schema.workspaceWriteLeases).get()).toMatchObject({
			status: "settled",
			executionClass: "local_file_io",
			mutationManifestJson: { mutations: [{ outcome: "applied" }] },
		});
	});

	test("cancellation during preparation commits no-dispatch and retains replay barrier", async () => {
		const path = join(workspace, "prepare-cancel.txt");
		await writeFile(path, "old");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		const evidence = new FileChangeEvidenceService(db);
		const finalize = evidence.finalizePreparation.bind(evidence);
		spyOn(evidence, "finalizePreparation").mockImplementation(async (...args) => {
			const result = await finalize(...args);
			controller.abort(new Error("cancel preparation"));
			return result;
		});
		runtime = makeRuntime({ evidence });
		const apply = spyOn(io, "apply");
		expect((await write(path, "new", context)).isError).toBe(true);
		expect(apply).not.toHaveBeenCalled();
		expect(operations()[0]).toMatchObject({
			settlement: "settled",
			executionOutcome: "interrupted",
			reason: "no_dispatch:cancelled_before_dispatch",
		});
		expect(effects()[0]).toMatchObject({ settlement: "settled", outcome: "no_change" });
		expect(await readFile(path, "utf8")).toBe("old");
		expect((await write(path, "new", context)).isError).toBe(true);
		expect(apply).not.toHaveBeenCalled();
	});

	test("cancellation during a metadata retry interrupts only the operation, not its applied receipt", async () => {
		const path = join(workspace, "cancel-metadata.txt");
		await writeFile(path, "old");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		const evidence = new FileChangeEvidenceService(db);
		const finish = evidence.finishOperation.bind(evidence);
		let attempts = 0;
		spyOn(evidence, "finishOperation").mockImplementation((...args) => {
			if (++attempts === 1) {
				controller.abort(new Error("cancel while metadata busy"));
				throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
			}
			return finish(...args);
		});
		runtime = makeRuntime({ evidence });
		const apply = spyOn(io, "apply");
		expect((await write(path, "new", context)).isError).toBe(true);
		expect(attempts).toBe(2);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(operations()[0].executionOutcome).toBe("interrupted");
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			executionReceiptJson: { confirmed: true, outcome: "applied" },
		});
	});

	test.each([
		"SQLITE_BUSY",
		"SQLITE_LOCKED",
		"SQLITE_CONSTRAINT",
	])("settlement retries only transient metadata errors %s without IO replay", async (code) => {
		const path = join(workspace, "metadata-retry.txt");
		await writeFile(path, "old");
		const evidence = new FileChangeEvidenceService(db);
		const finish = evidence.finishOperation.bind(evidence);
		let attempts = 0;
		spyOn(evidence, "finishOperation").mockImplementation((...args) => {
			attempts++;
			if (attempts <= 3) throw Object.assign(new Error("injected metadata failure"), { code });
			return finish(...args);
		});
		runtime = makeRuntime({ evidence });
		const apply = spyOn(io, "apply");
		const result = await write(path, "new");
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await readFile(path, "utf8")).toBe("new");
		expect(attempts).toBe(code === "SQLITE_CONSTRAINT" ? 1 : 4);
		if (code === "SQLITE_CONSTRAINT") {
			expect(result.isError).toBe(true);
			expect(effects()[0].executionReceiptJson).toBeNull();
		} else {
			expect(result.isError).toBeUndefined();
			expect(effects()[0].settlement).toBe("settled");
			expect(operations()[0].executionOutcome).toBe("succeeded");
		}
	});

	test("cancellation after a real partial dispatch settles unknown, never retries matching bytes", async () => {
		const path = join(workspace, "partial.txt");
		await writeFile(path, "old");
		const context = await callContext("Write", path);
		const controller = new AbortController();
		context.signal = controller.signal;
		let count = 0;
		io.apply = async (input) => {
			count++;
			input.onDispatch();
			await writeFile(path, "new");
			controller.abort(new Error("cancel-after-dispatch"));
			throw controller.signal.reason;
		};
		expect((await write(path, "new", context)).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new");
		expect(effects()[0]).toMatchObject({
			outcome: "unknown",
			settlement: "reconcile_required",
			executionReceiptJson: { confirmed: false, outcome: "unknown" },
			linesAdded: null,
		});
		expect(operations()[0].executionOutcome).toBe("interrupted");
		expect(pendingScope()).toMatchObject({ status: "active", activeLeaseId: null });
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
				.all(),
		).toHaveLength(1);
		expect((await write(path, "new", context)).isError).toBe(true);
		expect(count).toBe(1);
	});

	test("runtime generation change between capture and dispatch is not executed", async () => {
		const path = join(workspace, "generation.txt");
		await writeFile(path, "old");
		let generation = 0;
		runtime = makeRuntime({
			readRuntime: () => ({ runtimeEpoch: "test-local", runtimeGeneration: generation }),
		});
		io.apply = async (input) => {
			generation++;
			return fileChangeLocalIo.apply(input);
		};
		expect((await write(path, "new")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("old");
		expect(effects()[0].executionReceiptJson).toMatchObject({
			outcome: "not_applied",
			confirmed: true,
		});
	});

	test("queued cancellation and cancellation before dispatch never write", async () => {
		const path = join(workspace, "cancel.txt");
		await writeFile(path, "one");
		const gate = deferred();
		const entered = deferred();
		io.apply = async (input) => {
			entered.resolve();
			await gate.promise;
			return fileChangeLocalIo.apply(input);
		};
		const first = write(path, "two");
		await entered.promise;
		const ctx = await callContext("Write", path);
		const controller = new AbortController();
		ctx.signal = controller.signal;
		const second = write(path, "three", ctx);
		controller.abort();
		gate.resolve();
		expect((await first).isError).toBeUndefined();
		expect((await second).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("two");
		expect(effects()).toHaveLength(1);
	});
});

describe("stage-aware failures and durable narrow quarantine", () => {
	for (const withoutBlobs of [false, true]) {
		test(`first mkdir refusal does not quarantine unrelated writes (${withoutBlobs ? "no blobs" : "journal"})`, async () => {
			await runtime.initialize();
			if (withoutBlobs) {
				await rm(join(privateRoot, "file-change-source.json"), { force: true });
				db = database(sqlite);
				runtime = makeRuntime();
			}
			const parent = join(workspace, "refused");
			const path = join(parent, "tasks.json");
			const controlled = createFileChangeLocalIo({
				lstat,
				open,
				async mkdir(current) {
					if (current === parent)
						throw Object.assign(new Error("mkdir denied"), { code: "EACCES" });
					return mkdir(current);
				},
			});
			io.apply = (input) => controlled.apply(input);
			const result = await write(path, "not written");
			expect(result.isError).toBe(true);
			expect(result.output).toContain("mkdir denied");
			await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				db
					.select()
					.from(schema.workspaceWriteLeases)
					.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
					.all(),
			).toHaveLength(0);
			const unrelated = await write(join(workspace, "unrelated.txt"), "works");
			expect(unrelated.isError).toBeUndefined();
			if (withoutBlobs) {
				expect(unrelated.metadata?.fileChangeHistoryUnavailable).toBe(true);
				expect(effects()).toHaveLength(0);
			}
			if (!withoutBlobs)
				expect(effects()[0].executionReceiptJson).toMatchObject({
					confirmed: true,
					outcome: "not_applied",
					localIo: {
						version: 1,
						outcome: "not_applied",
						createdParentCount: 0,
						uncertainParentCount: 0,
					},
				});
		});
	}

	test("a settled unknown file blocks only itself across coordinator recreation", async () => {
		const path = join(workspace, "uncertain.txt");
		await writeFile(path, "before");
		io.apply = async (input) => {
			await fileChangeLocalIo.apply(input);
			throw new Error("acknowledgement lost after write");
		};
		expect((await write(path, "after")).isError).toBe(true);
		const barrier = db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
			.get();
		expect(barrier).toMatchObject({
			rangesJson: { version: 1, ranges: [{ kind: "file", canonicalPath: path }] },
			mutationManifestJson: {
				version: 1,
				mutations: [
					{
						mutationId: effects()[0].mutationId,
						operationId: operations()[0].id,
						effectId: effects()[0].id,
						outcome: "unknown",
					},
				],
			},
		});
		expect(barrier?.executionEndedAt).toBeTruthy();
		io.apply = (input) => fileChangeLocalIo.apply(input);
		expect((await write(join(workspace, "sibling.txt"), "usable")).isError).toBeUndefined();
		expect((await write(path, "blocked")).isError).toBe(true);
		runtime = makeRuntime();
		expect((await write(join(workspace, "after-restart.txt"), "usable")).isError).toBeUndefined();
		expect((await write(path, "still blocked")).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("after");
	});

	test("uncertain parent creation quarantines its missing subtree, not the existing ancestor", async () => {
		const parent = join(workspace, "maybe-created");
		const path = join(parent, "file.txt");
		const controlled = createFileChangeLocalIo({
			lstat,
			open,
			async mkdir(current) {
				if (current === parent)
					throw Object.assign(new Error("mkdir IO uncertain"), { code: "EIO" });
				return mkdir(current);
			},
		});
		io.apply = (input) => controlled.apply(input);
		expect((await write(path, "not written")).isError).toBe(true);
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			outcome: "no_change",
			executionReceiptJson: {
				confirmed: true,
				outcome: "not_applied",
				localIo: { outcome: "parent_only", uncertainParentCount: 1 },
			},
		});
		expect(
			db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.status, "quarantined"))
				.get(),
		).toMatchObject({
			rangesJson: { version: 1, ranges: [{ kind: "subtree", canonicalPath: parent }] },
		});
		io.apply = (input) => fileChangeLocalIo.apply(input);
		expect((await write(join(workspace, "outside.txt"), "usable")).isError).toBeUndefined();
		expect((await write(join(parent, "another.txt"), "blocked")).isError).toBe(true);
	});
});
