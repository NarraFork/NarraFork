/**
 * RemoveWorktree runs only on a person's decision, checked through the real
 * `handlePermission` pipeline and the final start gate, not just the pure decision table:
 * plan mode and external (OAuth) sessions must never turn the request into a prompt the
 * agent answers itself, and an approval recorded by reflection or automation never starts it.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, narratorToolCalls } from "../../db/schema";
import { localPathSemantics } from "../../lib/agent/execution/path-semantics";
import { localBackend } from "../../lib/agent/execution/registry";
import { generateId } from "../../lib/id";
import type { RuntimePermissionConstraint } from "../narrator-permission";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realNarratorService = { ...(await import("../narrator-service")) };
mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: { ...realNarratorService.narratorService, updateStatus: async () => {} },
}));
const { handlePermission, recheckFinalToolExecutionPermission } = await import(
	"../narrator-permission"
);
const { narratorPersistence: persistence } = await import("../narrator-persistence");

let cwd: string;
const now = () => new Date().toISOString();

async function narrator(permissionMode: "bypassPermissions" | "default", traits: string[] = []) {
	await db.insert(narrators).values({
		id: "n",
		cwd,
		permissionMode,
		traits,
		dangerReflectionOverride: "standard",
		createdAt: now(),
		updatedAt: now(),
	});
}
async function persistedCall(input: Record<string, unknown>) {
	const toolUseId = `remove-${generateId()}`;
	const message = await persistence.persistAssistantMessage("n", {
		uuid: generateId(),
		session_id: "fixture",
		message: { content: [{ type: "tool_use", id: toolUseId, name: "RemoveWorktree", input }] },
	});
	const call = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.messageId, message.id),
	});
	if (!call) throw new Error("Missing persisted tool call");
	return {
		toolUseId,
		callId: call.id,
		binding: await persistence.getToolCallBinding("n", message.id, toolUseId, call.id),
	};
}
async function decide(input: Record<string, unknown>, constraint?: RuntimePermissionConstraint) {
	const call = await persistedCall(input);
	return handlePermission(
		"n",
		new AbortController().signal,
		"RemoveWorktree",
		input,
		call.toolUseId,
		cwd,
		"en",
		undefined,
		{
			toolCallBinding: call.binding,
			executionBackend: localBackend,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd,
				pathFlavor: localPathSemantics.flavor,
				runtimeGeneration: localBackend.runtimeGeneration ?? 0,
				selectionSource: "local_default",
			},
		},
		undefined,
		constraint,
	);
}

beforeEach(async () => {
	cleanDb(sqlite);
	cwd = await mkdtemp(join(tmpdir(), "nf-remove-worktree-permission-"));
});
afterEach(async () => {
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

for (const mode of ["bypassPermissions", "default"] as const) {
	test(`strict plan mode (${mode}) is a hard deny, never a prompt or a reflection`, async () => {
		await narrator(mode, ["plan"]);
		// A prompt would leave this pending; the soft-deny path asks once before denying.
		const pending = new Promise<"pending">((done) => setTimeout(() => done("pending"), 2000));
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await Promise.race([
				decide({ path: "/elsewhere/repo/nf-worktree-task", deleteBranch: true }),
				pending,
			]);
			expect(result === "pending" ? result : result.behavior).toBe("deny");
			expect(JSON.stringify(result)).toContain("Plan mode: RemoveWorktree");
		}
	});
}

test("an external OAuth session in bypassPermissions cannot approve it through reflection", async () => {
	await narrator("bypassPermissions");
	// Every device ceiling open, so only the tool's own rule can deny it.
	const constraint: RuntimePermissionConstraint = {
		permissionMode: "bypassPermissions",
		allowKnowledgeWrite: false,
		deviceAccess: { host: "readWrite", global: "readWrite", selfRegistered: "readWrite" },
		oauthClientId: "fixture-client",
		grantId: "fixture-grant",
	};
	// Outside the cwd the danger classifier rates it high, which used to start a reflection.
	for (const path of ["/elsewhere/repo/nf-worktree-task", join(cwd, ".worktrees", "task")]) {
		const result = await decide({ path, deleteBranch: true }, constraint);
		expect(result.behavior).toBe("deny");
		expect(JSON.stringify(result)).toContain("person's approval");
	}
});

test("the final start gate accepts only a person's recorded approval", async () => {
	await narrator("bypassPermissions");
	const input = { path: join(cwd, ".worktrees", "task") };
	for (const decidedBy of ["reflection", "auto", "user"] as const) {
		const call = await persistedCall(input);
		await db
			.update(narratorToolCalls)
			.set({ status: "running", permissionDecidedBy: decidedBy, permissionDecidedAt: now() })
			.where(eq(narratorToolCalls.id, call.callId));
		const check = recheckFinalToolExecutionPermission({
			narratorId: "n",
			toolName: "RemoveWorktree",
			input,
			toolUseId: call.toolUseId,
			binding: call.binding,
			cwd,
		});
		if (decidedBy === "user")
			await check.then(
				() => {},
				(cause: Error) => expect(cause.message).not.toContain("requires a person's approval"),
			);
		else await expect(check).rejects.toThrow("RemoveWorktree requires a person's approval");
	}
});
