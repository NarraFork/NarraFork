import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import type { ToolExecutionPlan, ToolExecutionTarget } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { narratorPersistence } from "./narrator-service";

// Use the normal public service initialization before loading codec-only exports.
const { reconstructToolExecutionPlan, reconstructToolExecutionTarget } = await import(
	"./narrator-persistence"
);

const { db } = await import("../db");
let narratorId: string, messageId: string, callId: string, toolUseId: string;
const now = () => new Date().toISOString();
beforeEach(async () => {
	narratorId = generateId();
	messageId = generateId();
	callId = generateId();
	toolUseId = generateId();
	await db.insert(narrators).values({ id: narratorId, createdAt: now(), updatedAt: now() });
	await db
		.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: now() });
	await db.insert(narratorToolCalls).values({
		id: callId,
		narratorId,
		messageId,
		toolUseId,
		toolName: "Read",
		inputJson: {},
		status: "initializing",
		createdAt: now(),
	});
});
afterEach(async () => {
	await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, callId));
	await db.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
	await db.delete(narrators).where(eq(narrators.id, narratorId));
});
function target(deviceId = "device-a", revision = 1): ToolExecutionTarget {
	const workspace: WorkspaceContext = {
		deviceId,
		cwd: "/selected",
		pathFlavor: "posix",
		revision: 0,
		contextKey: "a".repeat(64),
		capabilities: { switchDirectory: true },
		binding: {
			version: 1,
			bindingId: `binding-${deviceId}`,
			narratorId,
			deviceId,
			bindingRevision: revision,
			bindingKey: revision.toString(16).padStart(64, "0"),
		},
	};
	return {
		deviceId,
		backendKind: "remote",
		cwd: "/selected",
		baseCwd: "/selected",
		pathFlavor: "posix",
		runtimeGeneration: 7,
		selectionSource: "explicit",
		workspaceContext: workspace,
		workspaceBinding: workspace.binding,
	};
}
async function stored() {
	const row = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, callId),
	});
	if (!row) throw new Error("missing tool row");
	return row;
}

test("persisted execution target preserves its independent binding and original workspace snapshot", async () => {
	const original = target();
	await narratorPersistence.updateToolCallExecutionTarget(narratorId, toolUseId, original);
	const recovered = reconstructToolExecutionTarget(await stored());
	expect(recovered).toEqual(original);
	expect(recovered?.workspaceContext).not.toBe(original.workspaceContext);
	if (!original.workspaceContext) throw new Error("missing original workspace");
	original.workspaceContext.cwd = "/later-mutated";
	expect(recovered?.workspaceContext?.cwd).toBe("/selected");
});

test("permission-started tool cannot replace a binding while device and cwd remain identical", async () => {
	await narratorPersistence.updateToolCallExecutionTarget(narratorId, toolUseId, target());
	await db
		.update(narratorToolCalls)
		.set({ status: "pending" })
		.where(eq(narratorToolCalls.id, callId));
	await expect(
		narratorPersistence.updateToolCallExecutionTarget(narratorId, toolUseId, target("device-a", 2)),
	).rejects.toThrow("already frozen");
	expect(reconstructToolExecutionTarget(await stored())?.workspaceBinding?.bindingRevision).toBe(1);
});

test("recovery restores all multi-device endpoints and refuses malformed primary-only degradation", async () => {
	const plan: ToolExecutionPlan = {
		kind: "multi",
		primaryKey: "second",
		endpoints: [
			{ key: "first", operation: "read", target: target("device-a") },
			{ key: "second", operation: "write", target: target("device-b", 3) },
		],
	};
	await narratorPersistence.updateToolCallExecutionPlan(narratorId, toolUseId, plan);
	const row = await stored();
	expect(reconstructToolExecutionPlan(row)).toEqual(plan);
	expect(reconstructToolExecutionTarget(row)?.deviceId).toBe("device-b");
	const malformed = { ...row, executionTargetsJson: { ...plan, primaryKey: "missing" } };
	expect(() => reconstructToolExecutionPlan(malformed)).toThrow("primary endpoint");
	for (const endpoints of [undefined, null, "invalid"]) {
		const broken = {
			...row,
			executionTargetsJson: { kind: "multi", primaryKey: "second", endpoints },
		};
		// Deliberately corrupt persisted JSON must be rejected rather than upgraded.
		expect(() =>
			reconstructToolExecutionPlan(
				broken as unknown as Parameters<typeof reconstructToolExecutionPlan>[0],
			),
		).toThrow("Stored execution plan is invalid");
	}
});
