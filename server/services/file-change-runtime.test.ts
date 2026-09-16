import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { FILE_CHANGE_LIMITS, type FileChangeState } from "../../shared/file-change-protocol";
import { sqlite as isolatedTemplate } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { decodeFileBytes } from "../lib/agent/tools/encoding";
import { MAX_BATCH_OPERATIONS } from "../lib/agent/tools/struct-sed/commands";
import { writeTool } from "../lib/agent/tools/write";
import { withBashWriteLock, withWorkspaceWriteLock } from "../lib/agent/tools/write-serialization";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { worktreeWriteLock } from "../lib/async-mutex";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { FileChangeEvidenceService } from "./file-change-evidence";
import { type FileChangeLocalIo, fileChangeLocalIo } from "./file-change-local-io";
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
	tool: "Write" | "Edit",
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
		expect(operations()[0].settlement).toBe("preparing");
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

	test("after mismatch is an actual applied-but-unknown result, not success or rollback", async () => {
		const path = join(workspace, "after.txt");
		await writeFile(path, "old");
		io.apply = async (input) => {
			await fileChangeLocalIo.apply(input);
			await writeFile(path, "external-after");
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
		expect(pendingScope()?.status).toBe("needs_verification");
	});

	test("settlement DB failure keeps pending evidence/quarantine and never retries written IO", async () => {
		const path = join(workspace, "settle.txt");
		await writeFile(path, "old");
		const ctx = await callContext("Write", path);
		const apply = spyOn(io, "apply");
		sqlite.exec(
			"CREATE TRIGGER fail_settle BEFORE UPDATE OF execution_receipt_json ON file_change_effects BEGIN SELECT RAISE(ABORT, 'settlement-fault'); END",
		);
		expect((await write(path, "new", ctx)).isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new");
		expect(effects()[0]).toMatchObject({ settlement: "applying", executionReceiptJson: null });
		expect(pendingScope()).toMatchObject({ status: "needs_verification", activeMutationCount: 1 });
		expect((await write(path, "new", ctx)).isError).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	test("operation finish DB failure does not replace a frozen effect or report success", async () => {
		const path = join(workspace, "finish.txt");
		await writeFile(path, "old\n");
		sqlite.exec(
			"CREATE TRIGGER fail_finish BEFORE UPDATE OF execution_outcome ON file_change_operations WHEN NEW.execution_outcome = 'succeeded' BEGIN SELECT RAISE(ABORT, 'finish-fault'); END",
		);
		const result = await write(path, "new\n");
		expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(effects()[0]).toMatchObject({
			settlement: "settled",
			attributionGrade: "measured",
			linesAdded: 1,
			linesRemoved: 1,
			executionReceiptJson: { confirmed: true, outcome: "applied" },
		});
		expect(operations()[0].executionOutcome).toBe("running");
		expect(pendingScope()).toMatchObject({ status: "needs_verification", activeMutationCount: 1 });
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

	test("replacing a cached blob directory does not silently initialize a new namespace", async () => {
		await runtime.initialize();
		const blobs = join(privateRoot, "file-change-blobs");
		await rename(blobs, join(privateRoot, "retained-blobs"));
		await mkdir(blobs, { mode: 0o700 });
		const path = join(workspace, "changed-namespace.txt");
		const result = await write(path, "must not write");
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Blob directory identity changed");
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(operations()).toHaveLength(0);
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
				if (outcome === "error") throw new Error("injected pre-dispatch error");
				await fileChangeLocalIo.apply(input);
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
			await fileChangeLocalIo.apply(input);
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
			await fileChangeLocalIo.apply(input);
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
			await fileChangeLocalIo.apply(input);
			runtime.coordinator.endActivity(activity);
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
		spyOn(evidence, "settleEffect").mockImplementation((input) => {
			const result = settle(input);
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
			input.signal.throwIfAborted();
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
		expect(pendingScope()?.status).toBe("needs_verification");
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
			await fileChangeLocalIo.apply(input);
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
			await fileChangeLocalIo.apply(input);
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
