import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import {
	narratorFileSnapshots,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../../db/schema";
import { generateId } from "../../../id";
import type { ExecutionBackend } from "../../execution/backend";
import { posixPathSemantics, windowsPathSemantics } from "../../execution/path-semantics";
import { peekStash, putStash, resetStash } from "../../structural/stash";
import type { ToolContext } from "../../types";
import { structSedTool } from "../struct-sed";
import { previewStructSedChange } from "../struct-sed/tool";

function context(windows = false) {
	const paths = windows ? windowsPathSemantics : posixPathSemantics;
	const path = windows ? "C:\\work\\notes.txt" : "/remote/notes.txt";
	const backend = {
		kind: "remote",
		deviceId: "device-a",
		paths,
		pathFlavor: paths.flavor,
		runtimeGeneration: 1,
		defaultCwd: paths.dirname(path),
		statFile: async () => ({ isDirectory: false, isFile: true, size: 12 }),
		readFileBytes: async () => ({
			bytes: Buffer.from("alpha\nbravo\n"),
			truncated: false,
			totalSize: 12,
		}),
	} as unknown as ExecutionBackend;
	const ctx = {
		narratorId: "remote-test",
		cwd: "/host",
		signal: new AbortController().signal,
		resolveBackend: () => backend,
	} as unknown as ToolContext;
	return { ctx, backend, path };
}

afterEach(resetStash);

function bind(ctx: ToolContext, backend: ExecutionBackend, path: string) {
	const narratorId = generateId();
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	const timestamp = new Date().toISOString();
	db.insert(narrators)
		.values({ id: narratorId, title: "remote fixture", createdAt: timestamp, updatedAt: timestamp })
		.run();
	db.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: timestamp })
		.run();
	const cwd = backend.paths.dirname(path);
	ctx.narratorId = narratorId;
	ctx.currentToolUseId = toolUseId;
	ctx.toolCallBinding = { toolCallId, attempt: 1 };
	ctx.executionTarget = {
		deviceId: backend.deviceId,
		backendKind: "remote",
		cwd,
		pathFlavor: backend.pathFlavor,
		lexicalPath: path,
		canonicalPath: path,
		runtimeGeneration: backend.runtimeGeneration,
		selectionSource: "explicit",
	};
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "StructSed",
			status: "running",
			executionStartedAt: timestamp,
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionDeviceId: backend.deviceId,
			executionCwd: cwd,
			executionPathFlavor: backend.pathFlavor,
			resolvedFilePath: path,
			canonicalFilePath: path,
			runtimeGeneration: backend.runtimeGeneration,
			createdAt: timestamp,
		})
		.run();
	return {
		toolCallId,
		cleanup: () => {
			db.delete(narratorFileSnapshots)
				.where(eq(narratorFileSnapshots.narratorId, narratorId))
				.run();
			db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId)).run();
			db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).run();
			db.delete(narrators).where(eq(narrators.id, narratorId)).run();
		},
	};
}

test("remote batch preview is bounded and does not require writing capability", async () => {
	const { ctx, path } = context();
	const result = await previewStructSedChange(
		{
			file_path: path,
			operations: [
				{ command: "replace", address: "1", content: "ALPHA" },
				{ command: "replace", address: "2", content: "BRAVO" },
			],
		},
		ctx,
	);
	if ("error" in result) throw new Error(result.error);
	expect(result.preview.before).toBe("alpha\nbravo\n");
	expect(result.preview.after).toBe("ALPHA\nBRAVO\n");
});

test("Windows remote paths preview without accessing host filesystem", async () => {
	const { ctx, path } = context(true);
	const result = await structSedTool.execute(
		{ file_path: path, command: "delete", address: "1" },
		ctx,
	);
	expect(result.isError).not.toBe(true);
	expect(result.output).toContain("DRY RUN");
});

test("old remote executor rejects actual write with upgrade guidance", async () => {
	const { ctx, path } = context();
	const result = await structSedTool.execute(
		{ file_path: path, command: "delete", address: "1", dry_run: false },
		ctx,
	);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("upgrade");
});

test("remote writes require a real tool-call binding even with conditional write", async () => {
	const { ctx, backend, path } = context();
	let writes = 0;
	backend.conditionalWriteFileBytes = async () => {
		writes++;
	};
	const result = await structSedTool.execute(
		{ file_path: path, command: "delete", address: "1", dry_run: false },
		ctx,
	);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("recorded tool call");
	expect(writes).toBe(0);
});

test("cross-device stash insertion is allowed; source deletion is refused and retained", async () => {
	const { ctx, path } = context();
	const entry = putStash({
		narratorId: ctx.narratorId,
		filePath: path,
		deviceId: "device-b",
		pathFlavor: "posix",
		text: "alpha",
		startLine: 1,
		endLine: 1,
	});
	const inserted = await structSedTool.execute(
		{ file_path: path, command: "append", address: "2", from_stash: entry.handle },
		ctx,
	);
	expect(inserted.isError).not.toBe(true);
	const deleted = await structSedTool.execute(
		{ file_path: path, command: "delete", from_stash: entry.handle },
		ctx,
	);
	expect(deleted.isError).toBe(true);
	expect(deleted.output).toContain("source file on device device-b");
	expect("entry" in peekStash(entry.handle, ctx.narratorId)).toBe(true);
});

test("bound remote batch persists all resolved operations and required device snapshot", async () => {
	const { ctx, backend, path } = context();
	const fixture = bind(ctx, backend, path);
	let writes = 0;
	backend.conditionalWriteFileBytes = async (target, bytes, opts) => {
		writes++;
		expect(target).toBe(path);
		if (opts.expectedBytes === null) throw new Error("Expected existing file bytes");
		expect(Buffer.from(opts.expectedBytes).toString()).toBe("alpha\nbravo\n");
		expect(Buffer.from(bytes).toString()).toBe("ALPHA\nBRAVO\n");
		const snapshot = db
			.select()
			.from(narratorFileSnapshots)
			.where(eq(narratorFileSnapshots.narratorId, ctx.narratorId))
			.get();
		expect(snapshot?.deviceId).toBe("device-a");
		expect(snapshot?.originalContent).toBe("alpha\nbravo\n");
	};
	try {
		const result = await structSedTool.execute(
			{
				file_path: path,
				dry_run: false,
				operations: [
					{ command: "replace", address: "1", content: "ALPHA" },
					{ command: "replace", address: "2", content: "BRAVO" },
				],
			},
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(writes).toBe(1);
		expect(result.metadata?.fileChangeEvidence).toEqual({ version: 1, grade: "legacy_unverified" });
		const row = db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, fixture.toolCallId))
			.get();
		const input = row?.inputJson as Record<string, unknown>;
		expect(input.device).toBe("device-a");
		expect(input.operations).toBe(2);
		expect(JSON.parse(input.op1 as string).resolvedStartLine).toBe(1);
		expect(JSON.parse(input.op2 as string).resolvedStartLine).toBe(2);
	} finally {
		fixture.cleanup();
	}
});

test("bound conditional-write failure retains stash without pretending success", async () => {
	const { ctx, backend, path } = context();
	const fixture = bind(ctx, backend, path);
	const entry = putStash({
		narratorId: ctx.narratorId,
		filePath: "/source",
		deviceId: "device-b",
		text: "payload",
		startLine: 1,
		endLine: 1,
	});
	backend.conditionalWriteFileBytes = async () => {
		throw new Error("Conditional write conflict: changed");
	};
	try {
		const result = await structSedTool.execute(
			{
				file_path: path,
				command: "append",
				address: "2",
				from_stash: entry.handle,
				dry_run: false,
			},
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("conflict");
		expect("entry" in peekStash(entry.handle, ctx.narratorId)).toBe(true);
	} finally {
		fixture.cleanup();
	}
});

test("mismatched persisted binding never dispatches a write", async () => {
	const { ctx, backend, path } = context();
	const fixture = bind(ctx, backend, path);
	let writes = 0;
	backend.conditionalWriteFileBytes = async () => {
		writes++;
	};
	db.update(narratorToolCalls)
		.set({ executionAttempt: 2 })
		.where(eq(narratorToolCalls.id, fixture.toolCallId))
		.run();
	try {
		const result = await structSedTool.execute(
			{ file_path: path, command: "delete", address: "1", dry_run: false },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("row/attempt");
		expect(writes).toBe(0);
	} finally {
		fixture.cleanup();
	}
});

test("required snapshot persistence failure prevents dispatch", async () => {
	const { ctx, backend, path } = context();
	const fixture = bind(ctx, backend, path);
	let writes = 0;
	backend.conditionalWriteFileBytes = async () => {
		writes++;
	};
	const insert = spyOn(db, "insert").mockImplementation(() => {
		throw new Error("snapshot storage unavailable");
	});
	try {
		const result = await structSedTool.execute(
			{ file_path: path, command: "delete", address: "1", dry_run: false },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("snapshot storage unavailable");
		expect(writes).toBe(0);
	} finally {
		insert.mockRestore();
		fixture.cleanup();
	}
});

test("legacy stash is local and cannot delete matching text on remote", async () => {
	const { ctx, path } = context();
	const entry = putStash({
		narratorId: ctx.narratorId,
		filePath: path,
		text: "alpha",
		startLine: 1,
		endLine: 1,
	});
	const result = await structSedTool.execute(
		{ file_path: path, command: "delete", from_stash: entry.handle },
		ctx,
	);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("device local");
});
