import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import * as schema from "../../db/schema";
import type { AgentConfig, ToolCallBinding } from "../../lib/agent/types";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

// Copy the fully migrated isolated test schema, including generated columns and
// partial indexes. Reconstructing columns alone is not a real startup fixture.
const realDbModule = { ...(await import("../../db")) };
const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { executeTool } = await import("../../lib/agent/tool-executor");
const { requestPermissionRuleTool } = await import("../../lib/agent/tools/request-permission-rule");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { recoverOnStartup, recoverPermissionRuleRequestAuditsOnStartup } = await import(
	"../narrator-session"
);
const previousTool = toolRegistry.get("RequestPermissionRule");
toolRegistry.register(requestPermissionRuleTool);
let sequence = 0;
beforeEach(() => {
	cleanDb(sqlite);
});
afterAll(async () => {
	toolRegistry.unregister("RequestPermissionRule");
	if (previousTool) toolRegistry.register(previousTool);
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await closeRuntimeTestDb(sqlite);
});
async function fixture(
	status: "pending" | "approved" | "applied" | "alreadyExists" = "approved",
	attempt = 1,
) {
	const id = `runtime-${++sequence}`;
	const narratorId = `${id}-narrator`;
	const toolUseId = `${id}-use`;
	const messageId = `${id}-message`;
	await db.insert(schema.narrators).values({
		id: narratorId,
		cwd: "/tmp",
		status: "waiting",
		traits: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await db.insert(schema.narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: new Date().toISOString(),
	});
	await db.insert(schema.narratorToolCalls).values({
		id,
		narratorId,
		toolUseId,
		messageId,
		toolName: "RequestPermissionRule",
		status: "pending",
		executionAttempt: attempt,
		createdAt: new Date().toISOString(),
	});
	await db.insert(schema.permissionRuleRequests).values({
		id,
		narratorId,
		toolCallId: id,
		toolUseId,
		attempt,
		proposalJson: { input: {}, rule: {} },
		proposalHash: "fixture-hash",
		reason: "test",
		scope: "narrator",
		deviceId: "local",
		contextRevision: "fixture",
		status,
		approvalSource: status === "pending" ? null : "user",
		approvalUserId: status === "pending" ? null : "human-actor",
	});
	const binding: ToolCallBinding = { toolCallId: id, attempt };
	const controller = new AbortController();
	const config: AgentConfig = {
		narratorId,
		conversationId: id,
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		signal: controller.signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		onToolExecutionFinalAuthorization: async () => {
			throw new Error("New final deny or revoked actor");
		},
	};
	return {
		id,
		narratorId,
		toolUseId,
		binding,
		controller,
		config,
		read: () =>
			db
				.select()
				.from(schema.permissionRuleRequests)
				.where(eq(schema.permissionRuleRequests.id, id))
				.get(),
	};
}

describe("permission rule executor and cold-start audit cleanup", () => {
	test("the actual final execution gate denies without leaving a fake approved request", async () => {
		const actor = await fixture();
		const result = await executeTool(
			{
				name: "RequestPermissionRule",
				toolUseId: actor.toolUseId,
				input: { ruleType: "commandWhitelist", pattern: "git status", reason: "fixture" },
			},
			actor.config,
			{ toolCallBinding: actor.binding },
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("New final deny");
		expect(actor.read()?.status).toBe("failed");
		expect(actor.read()?.approvalUserId).toBe("human-actor");
		expect(db.select().from(schema.narratorWhitelistDirs).all()).toEqual([]);
	});
	test("an abort at the awaited permission boundary cancels the exact unconsumed approval", async () => {
		const actor = await fixture();
		actor.config.permissionHandler = async () => {
			actor.controller.abort("User interrupted");
			return { behavior: "allow" };
		};
		const result = await executeTool(
			{
				name: "RequestPermissionRule",
				toolUseId: actor.toolUseId,
				input: { ruleType: "commandWhitelist", pattern: "git status", reason: "fixture" },
			},
			actor.config,
			{ toolCallBinding: actor.binding },
		);
		expect(result.isError).toBe(true);
		expect(actor.read()?.status).toBe("cancelled");
		expect(actor.read()?.approvalUserId).toBe("human-actor");
	});
	test("a stale attempt cannot close a retry; applied and existing receipts remain terminal", async () => {
		for (const status of ["approved", "applied", "alreadyExists"] as const) {
			const actor = await fixture(status, status === "approved" ? 2 : 1);
			await executeTool(
				{
					name: "RequestPermissionRule",
					toolUseId: actor.toolUseId,
					input: { ruleType: "commandWhitelist", pattern: "git status", reason: "fixture" },
				},
				actor.config,
				{ toolCallBinding: { toolCallId: actor.id, attempt: 1 } },
			);
			expect(actor.read()?.status).toBe(status);
		}
	});
	test("real cold startup closes pending and approved audits without applying or erasing history", async () => {
		const pending = await fixture("pending");
		const approved = await fixture("approved");
		const applied = await fixture("applied");
		const existing = await fixture("alreadyExists");
		const obsolete = await fixture("approved");
		// Exercise the real indexed recovery during the full startup path, not just
		// an empty placeholder table that happens to accept the query.
		const compactId = "startup-legacy-compact";
		await db.insert(schema.narratorMessages).values({
			id: compactId,
			narratorId: pending.narratorId,
			role: "system",
			contentJson: [{ type: "compact", status: "compacting", mode: "blocking" }],
			contentText: "[Compacting]",
			createdAt: new Date().toISOString(),
		});
		await db.insert(schema.narratorMessageRefs).values({
			id: "startup-legacy-compact-ref",
			narratorId: pending.narratorId,
			messageId: compactId,
			seq: 0,
		});
		expect(
			db
				.select({ pending: schema.narratorMessages.compactPending })
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, compactId))
				.get()?.pending,
		).toBe(1);
		await db
			.update(schema.narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(schema.narratorToolCalls.id, obsolete.id));
		await recoverOnStartup();
		expect(
			db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, compactId))
				.get(),
		).toBeUndefined();
		expect(
			db
				.select()
				.from(schema.narratorMessageRefs)
				.where(eq(schema.narratorMessageRefs.messageId, compactId))
				.get(),
		).toBeUndefined();
		expect(pending.read()?.status).toBe("cancelled");
		expect(approved.read()?.status).toBe("cancelled");
		expect(approved.read()?.approvalSource).toBe("user");
		expect(approved.read()?.approvalUserId).toBe("human-actor");
		expect(applied.read()?.status).toBe("applied");
		expect(existing.read()?.status).toBe("alreadyExists");
		expect(obsolete.read()?.status).toBe("cancelled");
		expect(db.select().from(schema.permissionRuleRequests).all()).toHaveLength(5);
		expect(db.select().from(schema.narratorWhitelistDirs).all()).toEqual([]);
		await recoverPermissionRuleRequestAuditsOnStartup();
		expect(approved.read()?.status).toBe("cancelled");
	});
});
