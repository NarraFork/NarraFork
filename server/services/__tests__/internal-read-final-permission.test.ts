import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	fileChangeExecutionSegments,
	fileChangeOperations,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/registry";
import { readTool } from "../../lib/agent/tools/read";
import type { ToolCallBinding, ToolExecutionTarget } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import type { FinalToolPermissionCheck } from "../narrator-permission";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { handlePermission, recheckFinalToolExecutionPermission } = await import(
	"../narrator-permission"
);
await import("../narrator-service");
const { narratorPersistence: persistence } = await import("../narrator-persistence");
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { permissionRuleService } = await import("../permission-rule-service");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const originals = [toolRegistry.get("Eval"), toolRegistry.get("Read")];
let cwd: string;
let input: Record<string, unknown>;
let parentBinding: ToolCallBinding;
let parentMessageId: string;
let readSpy: ReturnType<typeof spyOn>;
let bodySpy: ReturnType<typeof spyOn>;
let signal: AbortSignal;
let controller: AbortController;
const now = () => new Date().toISOString();

beforeEach(async () => {
	cleanDb(sqlite);
	executionPolicyEngine.invalidate("n");
	cwd = await mkdtemp(join(tmpdir(), "nf-internal-read-final-"));
	await writeFile(join(cwd, "source.txt"), "first line\nsecond line\nthird line\n");
	await writeFile(join(cwd, "other.txt"), "other file\n");
	input = { file_path: join(cwd, "source.txt"), offset: 1, limit: 2 };
	controller = new AbortController();
	signal = controller.signal;
	await db.insert(narrators).values({
		id: "n",
		cwd,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	toolRegistry.register({
		name: "Eval",
		description: "parent fixture; only the permission and durable claim are exercised",
		parameters: z.object({}),
		execute: async () => {
			throw new Error("Fixture must not execute Eval");
		},
	});
	toolRegistry.register(readTool);
	const parent = await persistedCall("Eval", "eval", {});
	parentBinding = parent.binding;
	parentMessageId = parent.messageId;
	await approve("Eval", "eval", {}, parentBinding);
	await persistence.claimToolCallExecution("n", "eval", parentBinding, Date.now());
	readSpy = spyOn(localBackend, "readFileBytes");
	bodySpy = spyOn(readTool, "execute");
});
afterEach(async () => {
	readSpy.mockRestore();
	bodySpy.mockRestore();
	executionPolicyEngine.invalidate("n");
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
	toolRegistry.unregister("Eval");
	toolRegistry.unregister("Read");
	for (const tool of originals) if (tool) toolRegistry.register(tool);
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

async function persistedCall(toolName: string, toolUseId: string, args: Record<string, unknown>) {
	const message = await persistence.persistAssistantMessage("n", {
		uuid: generateId(),
		session_id: "fixture",
		message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input: args }] },
	});
	const call = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.messageId, message.id),
	});
	if (!call) throw new Error("Missing real persisted tool call");
	return {
		messageId: message.id,
		binding: await persistence.getToolCallBinding("n", message.id, toolUseId, call.id),
	};
}
async function approve(
	toolName: string,
	toolUseId: string,
	args: Record<string, unknown>,
	binding: ToolCallBinding,
	target?: ToolExecutionTarget,
) {
	const result = await handlePermission(
		"n",
		signal,
		toolName,
		args,
		toolUseId,
		cwd,
		"en",
		undefined,
		{
			toolCallBinding: binding,
			...(target ? { executionBackend: localBackend, executionTarget: target } : {}),
		},
	);
	expect(result.behavior).toBe("allow");
}
async function childCheck(
	ordinaryId?: string,
	storedInput = input,
): Promise<FinalToolPermissionCheck> {
	const child = ordinaryId
		? await persistedCall("Read", ordinaryId, storedInput)
		: await persistence.createInternalRead("n", "eval", parentBinding, storedInput, 1);
	const toolUseId = ordinaryId ?? ("toolUseId" in child ? child.toolUseId : "");
	const target: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor: localBackend.paths.flavor,
		lexicalPath: String(input.file_path),
		resolvedFilePath: String(input.file_path),
		canonicalPath: String(input.file_path),
		runtimeGeneration: localBackend.runtimeGeneration ?? 0,
		selectionSource: "session_default",
	};
	await persistence.updateToolCallExecutionTarget("n", toolUseId, target, child.binding);
	await approve("Read", toolUseId, input, child.binding, target);
	await persistence.claimToolCallExecution("n", toolUseId, child.binding, Date.now());
	return {
		narratorId: "n",
		toolName: "Read",
		toolUseId,
		binding: child.binding,
		input: { ...input },
		executionBackend: localBackend,
		executionTarget: target,
		cwd,
		signal,
	};
}
async function callRow(check: FinalToolPermissionCheck) {
	const row = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, check.binding.toolCallId),
	});
	if (!row) throw new Error("Missing child row");
	return row;
}
async function runIO(check: FinalToolPermissionCheck) {
	const fence = await recheckFinalToolExecutionPermission(check);
	fence.assertStillCurrent();
	return readTool.execute(check.input, {
		narratorId: "n",
		cwd,
		signal: check.signal ?? signal,
		locale: "en",
		toolCallBinding: check.binding,
		executionTarget: check.executionTarget,
		requestPermission: (name, args, id) => handlePermission("n", signal, name, args, id, cwd, "en"),
	});
}
async function expectDenied(check: FinalToolPermissionCheck) {
	await expect(runIO(check)).rejects.toThrow();
	expect(bodySpy).not.toHaveBeenCalled();
	expect(readSpy).not.toHaveBeenCalled();
}
async function patchParent(patch: Partial<typeof narratorToolCalls.$inferInsert>) {
	await db
		.update(narratorToolCalls)
		.set(patch)
		.where(eq(narratorToolCalls.id, parentBinding.toolCallId));
}
async function patchMetadata(check: FinalToolPermissionCheck, patch: Record<string, unknown>) {
	const row = await callRow(check);
	const stored = row.inputJson as Record<string, unknown>;
	await db
		.update(narratorToolCalls)
		.set({
			inputJson: { ...stored, __internalRead: { ...(stored.__internalRead as object), ...patch } },
		})
		.where(eq(narratorToolCalls.id, row.id));
}

test("real internal Read passes final fence and actual I/O without losing database audit metadata", async () => {
	const check = await childCheck();
	const storedBefore = (await callRow(check)).inputJson;
	expect(storedBefore).toEqual({
		...input,
		__internalRead: { parentToolCallId: parentBinding.toolCallId, parentAttempt: 1, sequence: 1 },
	});
	const result = await runIO(check);
	expect(result.isError).not.toBe(true);
	expect(result.output).toContain("first line");
	expect(result.output).toContain("second line");
	expect(bodySpy).toHaveBeenCalledTimes(1);
	expect(readSpy).toHaveBeenCalledTimes(1);
	expect((await callRow(check)).inputJson).toEqual(storedBefore);
	expect((await callRow(check)).messageId).toBe(parentMessageId);
});

test("ordinary model Read without metadata keeps the original exact-input authorization", async () => {
	const check = await childCheck("model-read");
	expect((await runIO(check)).isError).not.toBe(true);
	expect(readSpy).toHaveBeenCalledTimes(1);
});

for (const beforeFence of [true, false]) {
	test(`real internal lineage cannot bypass a new policy deny ${beforeFence ? "before" : "after"} final authorization`, async () => {
		const check = await childCheck();
		const fence = beforeFence ? undefined : await recheckFinalToolExecutionPermission(check);
		await permissionRuleService.createNarratorRule("n", {
			ruleType: "directoryBlacklist",
			value: {
				path: cwd,
				denyLevel: "denyAll",
				targetKind: "host",
				pathFlavor: localBackend.paths.flavor === "windows" ? "windows" : "posix",
			},
		});
		if (fence) {
			expect(() => fence.assertStillCurrent()).toThrow();
			expect(bodySpy).not.toHaveBeenCalled();
			expect(readSpy).not.toHaveBeenCalled();
		} else {
			await expectDenied(check);
		}
	});
}

test("internal Read cannot use the audit exception beyond the existing persisted input budget", async () => {
	const check = await childCheck();
	const row = await callRow(check);
	await db
		.update(narratorToolCalls)
		.set({ inputJson: { ...(row.inputJson as object), oversized: "x".repeat(512 * 1024) } })
		.where(eq(narratorToolCalls.id, row.id));
	await expectDenied(check);
});

for (const [field, value] of [
	["file_path", "other.txt"],
	["offset", 2],
	["limit", 1],
	["device", "local"],
	["commands", ["unapproved"]],
	["pages", "2"],
] as const) {
	test(`internal audit exception never removes or changes execution field ${field}`, async () => {
		const check = await childCheck();
		check.input[field] = field === "file_path" ? join(cwd, "other.txt") : value;
		await expectDenied(check);
	});
}

for (const id of ["model-read", `internal_read_${"x".repeat(21)}`]) {
	test(`model-supplied audit metadata and id ${id} cannot prove internal lineage`, async () => {
		const check = await childCheck(id, {
			...input,
			__internalRead: { parentToolCallId: parentBinding.toolCallId, parentAttempt: 1, sequence: 1 },
		});
		await expectDenied(check);
	});
}

test("internal id alone without persisted audit metadata cannot authorize the exception", async () => {
	await expectDenied(await childCheck(`internal_read_${"y".repeat(21)}`));
});

for (const [label, patch] of [
	["parent attempt", { executionAttempt: 2 }],
	["parent narrator", { narratorId: "other-narrator" }],
	["parent segment", { executionSegmentId: "wrong-segment" }],
	["completed parent", { status: "success" }],
	["pending parent", { status: "pending" }],
	["non-Eval parent", { toolName: "Read" }],
	["unclaimed parent", { executionStartedAt: null }],
	["missing parent approval", { permissionDecidedAt: null }],
	["invalid parent approval", { permissionDecidedBy: "forged" }],
	["legacy parent identity", { executionIdentityVersion: 0 }],
	["copied parent", { executionOriginToolCallId: "old-call" }],
	["sealed parent", { fileChangeOperationId: "sealed" }],
] as const) {
	test(`internal Read rejects ${label} before I/O`, async () => {
		const check = await childCheck();
		if ("narratorId" in patch) {
			await db
				.insert(narrators)
				.values({ id: patch.narratorId, createdAt: now(), updatedAt: now() });
		}
		if ("fileChangeOperationId" in patch) {
			await db.insert(fileChangeOperations).values({
				id: patch.fileChangeOperationId,
				sourceInstanceId: "internal-read-fixture",
				sourceKind: "tool",
				sourceId: parentBinding.toolCallId,
				toolCallId: parentBinding.toolCallId,
				attempt: parentBinding.attempt,
				narratorId: "n",
				actorSubjectKey: "narrator:n",
				actorJson: {
					kind: "primary",
					subjectKey: "narrator:n",
					narratorId: "n",
					userId: null,
					label: null,
					deleted: false,
					parentSubjectKey: null,
				},
				executionOutcome: "failed",
				effectOutcome: "no_change",
				settlement: "settled",
				reason: "no_dispatch:invocation_rejected",
				startedAt: now(),
				updatedAt: now(),
			});
		}
		await patchParent(patch);
		await expectDenied(check);
	});
}

for (const [label, table, patch] of [
	["child segment source", "child", { sourceToolCallId: "other-call" }],
	["child segment attempt", "child", { sourceExecutionAttempt: 2 }],
	["child segment narrator", "child", { narratorId: "other" }],
	["child parent segment", "child", { parentSegmentId: "other-segment" }],
	["parent segment source", "parent", { sourceToolCallId: "other-call" }],
	["parent segment attempt", "parent", { sourceExecutionAttempt: 2 }],
	["parent segment narrator", "parent", { narratorId: "other" }],
] as const) {
	test(`internal Read rejects incorrect ${label}`, async () => {
		const check = await childCheck();
		const segmentId =
			table === "child" ? check.binding.executionSegmentId : parentBinding.executionSegmentId;
		if (!segmentId) throw new Error("Missing actual execution segment");
		await db
			.update(fileChangeExecutionSegments)
			.set(patch)
			.where(eq(fileChangeExecutionSegments.id, segmentId));
		await expectDenied(check);
	});
}

for (const patch of [
	{ parentToolCallId: "fake-parent" },
	{ parentAttempt: 2 },
	{ parentAttempt: 0 },
	{ sequence: 0 },
	{ sequence: 1.5 },
	{ sequence: Number.MAX_SAFE_INTEGER + 1 },
	{ sequence: "1" },
	{ unexpected: true },
]) {
	test(`internal Read rejects invalid audit metadata ${JSON.stringify(patch)}`, async () => {
		const check = await childCheck();
		await patchMetadata(check, patch);
		await expectDenied(check);
	});
}

for (const mutation of [
	"status",
	"attempt",
	"segment",
	"approval",
	"claim",
	"metadata",
	"input",
	"lineage",
	"cancel",
] as const) {
	test(`synchronous final fence rechecks ${mutation} after initial real authorization`, async () => {
		const check = await childCheck();
		const fence = await recheckFinalToolExecutionPermission(check);
		if (mutation === "status") await patchParent({ status: "success" });
		if (mutation === "attempt") await patchParent({ executionAttempt: 2 });
		if (mutation === "segment") await patchParent({ executionSegmentId: "wrong-segment" });
		if (mutation === "approval") await patchParent({ permissionDecidedAt: null });
		if (mutation === "claim") await patchParent({ executionStartedAt: null });
		if (mutation === "metadata") await patchMetadata(check, { sequence: 2 });
		if (mutation === "input") {
			const row = await callRow(check);
			await db
				.update(narratorToolCalls)
				.set({ inputJson: { ...(row.inputJson as object), offset: 2 } })
				.where(eq(narratorToolCalls.id, row.id));
		}
		if (mutation === "lineage") {
			await db
				.update(fileChangeExecutionSegments)
				.set({ sourceExecutionAttempt: 2 })
				.where(eq(fileChangeExecutionSegments.id, parentBinding.executionSegmentId ?? ""));
		}
		if (mutation === "cancel") controller.abort(new Error("cancelled"));
		expect(() => fence.assertStillCurrent()).toThrow();
		expect(bodySpy).not.toHaveBeenCalled();
		expect(readSpy).not.toHaveBeenCalled();
	});
}
