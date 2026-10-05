import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import type { AgentConfig, ToolCallBinding } from "../../lib/agent/types";

// Real isolated SQLite declarations, no filesystem database or migration edits.
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
const tables: string[] = [];
for (const table of Object.values(schema)) {
	let config: ReturnType<typeof getTableConfig>;
	try {
		config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
	} catch {
		continue;
	}
	if (!config?.name || !config.columns) continue;
	tables.push(config.name);
	const columns = config.columns.map((column) => {
		const value = column.default;
		const defaultSql =
			value === undefined
				? ""
				: ` DEFAULT ${typeof value === "object" && value !== null && "queryChunks" in value ? dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : typeof value === "boolean" ? Number(value) : value === null ? "NULL" : typeof value === "object" ? `'${JSON.stringify(value).replaceAll("'", "''")}'` : value}`;
		return `${column.name} ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : ""}${defaultSql}`;
	});
	sqlite.run(`CREATE TABLE ${config.name} (${columns.join(",")})`);
}
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
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
	for (const table of tables) sqlite.run(`DELETE FROM ${table}`);
});
afterAll(() => {
	toolRegistry.unregister("RequestPermissionRule");
	if (previousTool) toolRegistry.register(previousTool);
	mock.restore();
	sqlite.close();
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
		await db
			.update(schema.narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(schema.narratorToolCalls.id, obsolete.id));
		await recoverOnStartup();
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
