import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { narratorService } = await import("../narrator-service");

const now = "2026-07-17T10:00:00.000Z";

async function seedNarrator(id = "n1") {
	await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role: "user" | "assistant" | "system";
	contentText?: string;
	contentJson?: unknown;
	isCompact?: boolean;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role,
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? "" }],
		contentText: params.contentText ?? null,
		provider: "provider-that-must-not-be-loaded",
		model: "model-that-must-not-be-loaded",
		tokensIn: 123,
		commandText: "/internal-command",
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.id}`,
		narratorId: params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("narrator model history projection", () => {
	test("loads post-compact history with narrow fields and legacy sidecar fallback", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-before",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "old",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-after",
			narratorId: "n1",
			seq: 3,
			role: "assistant",
			contentText: "new",
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-1",
			narratorId: "n1",
			messageId: "m-after",
			toolUseId: "tu-1",
			toolName: "Bash",
			inputJson: { command: "pwd" },
			outputJson: { stdout: "/workspace" },
			status: "success",
			createdAt: now,
		});
		await db.insert(narratorSidecars).values({
			id: "sc-legacy",
			narratorId: "n1",
			messageId: null,
			toolUseId: "tu-1",
			target: "tool_result",
			source: "legacy-provider",
			content: JSON.stringify({ stdout: "/workspace" }),
			createdAt: now,
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual(["m-after"]);
		expect(messages[0]).toMatchObject({
			id: "m-after",
			narratorId: "n1",
			role: "assistant",
			contentText: "new",
		});
		expect(messages[0]).not.toHaveProperty("provider");
		expect(messages[0]).not.toHaveProperty("model");
		expect(messages[0]).not.toHaveProperty("tokensIn");
		expect(messages[0]).not.toHaveProperty("commandText");
		expect(messages[0].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-1",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				outputJson: { stdout: "/workspace" },
				status: "success",
			}),
		]);
		expect(messages[0].sideCars).toEqual([
			expect.objectContaining({
				id: "sc-legacy",
				messageId: null,
				toolUseId: "tu-1",
				target: "tool_result",
			}),
		]);
	});

	test("projects pending permissions without loading unrelated tool-call metadata", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-pending",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentText: "tool",
		});
		await db.insert(narratorToolCalls).values([
			{
				id: "tc-visible",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-visible",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				status: "pending",
				permissionDecisionReason: "needs approval",
				permissionSuggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				resolvedFilePath: "/workspace/file.txt",
				deviceSelectionSource: "local_default",
				provider: "provider-that-must-not-be-loaded",
				model: "model-that-must-not-be-loaded",
				createdAt: now,
			},
			{
				id: "tc-hidden",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-hidden",
				toolName: "Edit",
				inputJson: { path: "/workspace/file.txt" },
				status: "pending",
				permissionSuggestions: [{ type: "danger_reflection", status: "running" }],
				createdAt: now,
			},
		]);

		const permissions = await narratorService.getPendingPermissions("n1");

		expect(permissions).toEqual([
			{
				id: "tc-visible",
				toolName: "Bash",
				toolUseId: "tu-visible",
				inputJson: { command: "pwd" },
				decisionReason: "needs approval",
				suggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				resolvedFilePath: "/workspace/file.txt",
				deviceSelectionSource: "local_default",
			},
		]);
	});
});
