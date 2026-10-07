import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { OutputContentAccumulator } from "../../lib/agent/output-content";
import { toolRegistry } from "../../lib/agent/tool-registry";
import type { AgentEvent } from "../../lib/agent/types";
import { measureMessageCharacters } from "../../lib/context-characters";
import type { EventHandlerContext } from "../narrator-event-handler";

// This fixture follows the current schema without depending on gitignored migration
// artifacts, and never writes to drizzle/ or opens a production database.
const sqlite = new Database(":memory:");
const statements = await generateSQLiteMigration(
	await generateSQLiteDrizzleJson({}),
	await generateSQLiteDrizzleJson(schema),
);
for (const statement of statements) sqlite.run(statement);
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
function cleanDb() {
	sqlite.run("PRAGMA foreign_keys = OFF");
	const tables = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as { name: string }[];
	for (const { name } of tables) sqlite.run(`DELETE FROM "${name.replaceAll('"', '""')}"`);
	sqlite.run("PRAGMA foreign_keys = ON");
}
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("../../db", () => dbStub);
mock.module("@server/db", () => dbStub);
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const {
	cleanupIncompleteNarratorOutput,
	completeAssistantOutput,
	completeOutputBlocks,
	removeIncompleteOutputBlocks,
} = await import("../narrator-output-recovery");
const { processEvent, clearStreamingSnapshot } = await import("../narrator-event-handler");
const now = new Date().toISOString();

function makeContext(): EventHandlerContext {
	let partialId: string | undefined;
	return {
		narratorId: "owner",
		broadcastTargetId: "owner",
		conversationId: "output-test",
		locale: "en",
		getPartialMessageId: () => partialId,
		setPartialMessageId: (id) => {
			partialId = id;
		},
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
}

async function persist(events: Iterable<AgentEvent>, ctx: EventHandlerContext) {
	for (const event of events) await processEvent(event, ctx);
}

function seed() {
	for (const id of ["owner", "fork"])
		sqlite
			.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
			.run(id, now, now);
}
function message(id: string) {
	const row = sqlite
		.prepare(
			"SELECT content_json AS content, content_text AS text, context_chars_json AS chars FROM narrator_messages WHERE id = ?",
		)
		.get(id) as { content: string; text: string | null; chars: string | null };
	return {
		content: JSON.parse(row.content),
		text: row.text,
		chars: JSON.parse(row.chars ?? "null"),
	};
}

beforeEach(() => {
	clearStreamingSnapshot("owner");
	cleanDb();
	seed();
});
afterAll(() => {
	mock.restore();
});

describe("cold recovery output boundary", () => {
	test("the actual consumer persists unchanged native completion and final success", async () => {
		const ctx = makeContext();
		const output = new OutputContentAccumulator();
		const lane = { blockId: "native-text", outputIndex: 0 };
		output.append("text", "answer", lane);
		await persist(output.flush(), ctx);
		const id = ctx.getPartialMessageId() as string;
		expect(message(id).content[0]).toMatchObject({ completed: false, revision: 1 });
		await persist(output.boundary({ kind: "text", phase: "complete", ...lane }), ctx);
		expect(message(id).content[0]).toMatchObject({ completed: true, revision: 2 });
		output.append("reasoning", "thought");
		await persist(output.flush(), ctx);
		expect(message(id).content[1]).toMatchObject({ completed: false });
		await processEvent({ type: "assistant_message", text: "answer", toolUses: [] }, ctx);
		expect(message(id).content.every((block: { completed?: boolean }) => block.completed)).toBe(
			true,
		);
		expect((await cleanupIncompleteNarratorOutput("owner")).removedBlocks).toBe(0);
	});

	for (const error of ["Aborted", "network failed"]) {
		test(`${error}: consumer flush retains incomplete state until cold cleanup`, async () => {
			const ctx = makeContext();
			const output = new OutputContentAccumulator();
			output.append("text", "partial");
			await persist(output.flush(), ctx);
			const id = ctx.getPartialMessageId() as string;
			await processEvent({ type: "error", message: error }, ctx);
			expect(message(id).content[0]).toMatchObject({ completed: false });
			expect((await cleanupIncompleteNarratorOutput("owner")).removedBlocks).toBe(1);
		});
	}

	test("retained error assistant event does not promote incomplete blocks", async () => {
		const ctx = makeContext();
		const output = new OutputContentAccumulator();
		output.append("text", "partial");
		await persist(output.flush(), ctx);
		const id = ctx.getPartialMessageId() as string;
		await processEvent(
			{ type: "assistant_message", text: "partial", toolUses: [], outputCompleted: false },
			ctx,
		);
		expect(message(id).content[0]).toMatchObject({ completed: false });
		expect((await cleanupIncompleteNarratorOutput("owner")).removedBlocks).toBe(1);
	});

	test("removes only explicitly incomplete textual blocks without mutating originals", () => {
		const content = [
			{ type: "text", text: "partial", completed: false },
			{ type: "reasoning", text: "partial thought", completed: false },
			{ type: "text", text: "done", completed: true },
			{ type: "reasoning", text: "legacy" },
			{ type: "tool_use", id: "tool", completed: false },
			{ type: "redacted_thinking", data: "secret", completed: false },
			null,
		];
		expect(removeIncompleteOutputBlocks(content)).toEqual(content.slice(2));
		expect(content).toHaveLength(7);
		expect(removeIncompleteOutputBlocks(content.slice(2))).toBeUndefined();
		expect(removeIncompleteOutputBlocks({ type: "text" })).toBeUndefined();
	});

	test("success completion includes legacy textual blocks but never changes tool state", () => {
		const tool = { type: "tool_use", id: "t", completed: false };
		const content = [{ type: "text", text: "x", completed: false }, { type: "reasoning" }, tool];
		const completed = completeOutputBlocks(content);
		expect(completed).toEqual([
			{ type: "text", text: "x", completed: true },
			{ type: "reasoning", completed: true },
			tool,
		]);
		expect(completed?.[2]).toBe(tool);
		expect(completeOutputBlocks(completed)).toBeUndefined();
		expect(content[0]).toMatchObject({ completed: false });
	});

	test("a forked partial uses COW, keeps tool rows and updates recipient character accounting", async () => {
		const content = [
			{ type: "text", id: "done", text: "retained", completed: true },
			{ type: "text", id: "partial", text: "abandoned", completed: false },
			{ type: "reasoning", text: "unfinished thought", completed: false },
			{ type: "reasoning", text: "legacy thought" },
			{ type: "tool_use", id: "t", name: "Read", input: {} },
		];
		const saved = await narratorPersistence.persistAssistantMessage("owner", {
			session_id: "output-test",
			uuid: "test-output",
			message: { content },
		});
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
			)
			.run("fork-ref", "fork", saved.id, 1);
		const original = message(saved.id);
		const result = await cleanupIncompleteNarratorOutput("fork");
		expect(result.removedBlocks).toBe(2);
		expect(result.messageId).not.toBe(saved.id);
		const cleaned = message(result.messageId as string);
		expect(cleaned.content).toEqual([content[0], content[3], content[4]]);
		expect(cleaned.text).toBe("retained");
		expect(cleaned.chars).toEqual(
			measureMessageCharacters("assistant", cleaned.content, cleaned.text),
		);
		expect(message(saved.id)).toEqual(original);
		const copiedTools = sqlite
			.prepare("SELECT tool_name AS name FROM narrator_tool_calls WHERE message_id = ?")
			.all(result.messageId as string);
		expect(copiedTools).toEqual([{ name: "Read" }]);
		expect((await cleanupIncompleteNarratorOutput("fork")).removedBlocks).toBe(0);
	});

	test("success marks checkpointed text completed, so cold recovery preserves it", async () => {
		const saved = await narratorPersistence.persistAssistantMessage("owner", {
			session_id: "output-test",
			uuid: "test-complete",
			message: { content: [{ type: "text", text: "answer", completed: false }] },
		});
		expect(await completeAssistantOutput("owner", saved.id)).toBe(saved.id);
		expect(message(saved.id).content).toEqual([{ type: "text", text: "answer", completed: true }]);
		expect((await cleanupIncompleteNarratorOutput("owner")).removedBlocks).toBe(0);
	});

	test("a shared pending owner attempt keeps its identity even when no text needs cleanup", async () => {
		const saved = await narratorPersistence.persistAssistantMessage("owner", {
			session_id: "output-test",
			uuid: "shared-complete-output",
			message: {
				content: [
					{ type: "text", text: "already complete", completed: true },
					{ type: "tool_use", id: "already-complete-pending", name: "Read", input: {} },
				],
			},
		});
		const [call] = await db.query.narratorToolCalls.findMany({
			where: eq(schema.narratorToolCalls.messageId, saved.id),
		});
		if (!call) throw new Error("Fixture did not persist its execution row");
		await db
			.update(schema.narratorToolCalls)
			.set({ status: "pending" })
			.where(eq(schema.narratorToolCalls.id, call.id));
		await db
			.insert(schema.narratorMessageRefs)
			.values({ id: "complete-output-fork-ref", narratorId: "fork", messageId: saved.id, seq: 1 });
		const binding = await narratorPersistence.getToolCallBinding(
			"owner",
			saved.id,
			call.toolUseId,
			call.id,
		);
		expect((await cleanupIncompleteNarratorOutput("owner")).removedBlocks).toBe(0);
		const resumed = await narratorPersistence.prepareToolCallAttempt("owner", call.id, true);
		expect(resumed.toolCall.id).toBe(call.id);
		expect(resumed.toolCall.messageId).toBe(saved.id);
		expect(resumed.toolCall.executionOriginToolCallId).toBeNull();
		expect(resumed.requiresFreshPermission).toBe(false);
		expect(
			await narratorPersistence.getToolCallBinding("owner", saved.id, call.toolUseId, call.id),
		).toEqual(binding);
		const fork = await db.query.narratorMessageRefs.findFirst({
			where: eq(schema.narratorMessageRefs.id, "complete-output-fork-ref"),
		});
		expect(fork?.messageId).not.toBe(saved.id);
	});

	test("successful shared-owner finalization keeps the pending execution binding", async () => {
		const saved = await narratorPersistence.persistAssistantMessage("owner", {
			session_id: "output-test",
			uuid: "shared-finalization",
			message: {
				content: [
					{ type: "text", text: "answer", completed: false },
					{ type: "tool_use", id: "shared-pending", name: "Read", input: {} },
				],
			},
		});
		const [call] = await db.query.narratorToolCalls.findMany({
			where: eq(schema.narratorToolCalls.messageId, saved.id),
		});
		if (!call) throw new Error("Fixture did not persist its execution row");
		await db
			.update(schema.narratorToolCalls)
			.set({ status: "pending" })
			.where(eq(schema.narratorToolCalls.id, call.id));
		await db
			.insert(schema.narratorMessageRefs)
			.values({ id: "completion-fork-ref", narratorId: "fork", messageId: saved.id, seq: 1 });
		const binding = await narratorPersistence.getToolCallBinding(
			"owner",
			saved.id,
			call.toolUseId,
			call.id,
		);
		const before = message(saved.id);
		expect(await completeAssistantOutput("owner", saved.id)).toBe(saved.id);
		expect(message(saved.id).content[0]).toMatchObject({ completed: true });
		expect(
			await narratorPersistence.getToolCallBinding("owner", saved.id, call.toolUseId, call.id),
		).toEqual(binding);
		expect(
			(await narratorPersistence.prepareToolCallAttempt("owner", call.id, true)).toolCall.id,
		).toBe(call.id);
		const fork = await db.query.narratorMessageRefs.findFirst({
			where: eq(schema.narratorMessageRefs.id, "completion-fork-ref"),
		});
		if (!fork) throw new Error("Finalization removed the fork's history ref");
		expect(fork.messageId).not.toBe(saved.id);
		expect(message(fork.messageId)).toEqual(before);
	});

	test("shared owner output cleanup preserves the real restart approval and Agent origin", async () => {
		const { prepareOrdinaryRestartRecovery, resetRestartRecoveryForTests } = await import(
			"../restart-recovery-service"
		);
		const { executePersistedToolCall } = await import("../narrator-session");
		const { pendingPermissions } = await import("../narrator-session-state");
		const { resolvePermission } = await import("../narrator-permission");
		const { getNarraforkHome } = await import("../../lib/narrafork-home");
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const directory = await mkdtemp(join(tmpdir(), "output-restart-cow-"));
		const previousHome = process.env.NARRAFORK_HOME;
		const realAgent = { ...(await import("../../lib/agent")) };
		// Provider formatting alone must not acquire external credentials in a tool-only
		// fixture. Restart, COW, attempt guards, final authorization and approvals stay real.
		mock.module("../../lib/agent", () => ({
			...realAgent,
			buildHistory: async () => ({ history: [], trailingToolResults: [] }),
		}));
		process.env.NARRAFORK_HOME = directory;
		resetRestartRecoveryForTests();
		let executions = 0;
		toolRegistry.register({
			name: "OutputRecoveryProbe",
			description: "safe recovery probe",
			parameters: z.object({ value: z.number() }),
			execute: async () => {
				executions++;
				return { output: "approval survived shared output cleanup" };
			},
		});
		try {
			await db
				.update(schema.narrators)
				.set({
					status: "waiting",
					logicalRunId: "owner-run",
					model: "codex:gpt-5.5",
					permissionMode: "bypassPermissions",
				})
				.where(eq(schema.narrators.id, "owner"));
			const content = [
				{ type: "text", text: "done", completed: true },
				{ type: "text", text: "abandoned", completed: false },
				{ type: "tool_use", id: "origin-agent", name: "Agent", input: {} },
				{
					type: "tool_use",
					id: "approval-probe",
					name: "OutputRecoveryProbe",
					input: { value: 42 },
				},
			];
			const saved = await narratorPersistence.persistAssistantMessage("owner", {
				session_id: "output-test",
				uuid: "shared-pending-output",
				message: { content },
			});
			const calls = await db.query.narratorToolCalls.findMany({
				where: eq(schema.narratorToolCalls.messageId, saved.id),
			});
			const origin = calls.find((call) => call.toolUseId === "origin-agent");
			const probe = calls.find((call) => call.toolUseId === "approval-probe");
			if (!origin || !probe) throw new Error("Fixture did not persist both execution rows");
			await db
				.update(schema.narratorToolCalls)
				.set({ status: "pending" })
				.where(eq(schema.narratorToolCalls.id, probe.id));
			await db.insert(schema.narrators).values({
				id: "running-child",
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: "owner",
				originToolCallId: origin.id,
				status: "working",
				logicalRunId: "child-run",
				createdAt: now,
				updatedAt: now,
			});
			await db
				.insert(schema.narratorMessageRefs)
				.values({ id: "snapshot-ref", narratorId: "fork", messageId: saved.id, seq: 1 });
			const before = message(saved.id);
			const source = await narratorPersistence.getToolCallBinding(
				"owner",
				saved.id,
				probe.toolUseId,
				probe.id,
			);
			const prepared = await prepareOrdinaryRestartRecovery({
				narratorIds: new Set(),
				toolCallIds: new Set(),
				backgroundTaskIds: new Set(),
			});
			expect(prepared.protection.toolCallIds.has(probe.id)).toBe(true);
			expect(prepared.protection.toolCallIds.has(origin.id)).toBe(true);
			expect(message(saved.id).content).toEqual(
				content.filter((block) => block.completed !== false),
			);
			const forkRef = await db.query.narratorMessageRefs.findFirst({
				where: eq(schema.narratorMessageRefs.id, "snapshot-ref"),
			});
			if (!forkRef) throw new Error("Shared history ref was lost during output cleanup");
			expect(forkRef.messageId).not.toBe(saved.id);
			expect(message(forkRef.messageId)).toEqual(before);
			const historyTools = await db.query.narratorToolCalls.findMany({
				where: eq(schema.narratorToolCalls.messageId, forkRef.messageId),
			});
			expect(historyTools.every((call) => call.executionOriginToolCallId !== null)).toBe(true);
			expect(historyTools.every((call) => !prepared.protection.toolCallIds.has(call.id))).toBe(
				true,
			);
			const child = await db.query.narrators.findFirst({
				where: eq(schema.narrators.id, "running-child"),
			});
			expect(child?.originToolCallId).toBe(origin.id);
			const resumedAttempt = await narratorPersistence.prepareToolCallAttempt(
				"owner",
				probe.id,
				true,
			);
			expect(resumedAttempt.toolCall.id).toBe(probe.id);
			expect(
				await narratorPersistence.getToolCallBinding("owner", saved.id, probe.toolUseId, probe.id),
			).toEqual(source);
			const execution = executePersistedToolCall({ toolCallId: probe.id, narratorId: "owner" });
			let finished = false;
			void execution.then(
				() => {
					finished = true;
				},
				() => {
					finished = true;
				},
			);
			const deadline = Date.now() + 2_000;
			while (!pendingPermissions.has(probe.id) && !finished && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 5));
			if (finished && !pendingPermissions.has(probe.id)) {
				const outcome = await execution;
				const persisted = await db.query.narratorToolCalls.findFirst({
					where: eq(schema.narratorToolCalls.id, probe.id),
				});
				throw new Error(
					`Recovery ended before approval: ${JSON.stringify({ outcome, output: persisted?.outputJson })}`,
				);
			}
			expect(pendingPermissions.has(probe.id)).toBe(true);
			expect(executions).toBe(0);
			expect(await resolvePermission(probe.id, "allow")).toBe(true);
			expect(await execution).toMatchObject({ ok: true, shouldContinue: true });
			expect(executions).toBe(1);
			const result = await db.query.narratorToolCalls.findFirst({
				where: eq(schema.narratorToolCalls.id, probe.id),
			});
			expect(result?.status).toBe("success");
			expect(result?.outputJson).toBe("approval survived shared output cleanup");
			expect(message(forkRef.messageId)).toEqual(before);
			const snapshotProbe = historyTools.find((call) => call.toolUseId === probe.toolUseId);
			if (!snapshotProbe) throw new Error("Sibling snapshot did not preserve the tool history");
			const forkProbe = await db.query.narratorToolCalls.findFirst({
				where: eq(schema.narratorToolCalls.id, snapshotProbe.id),
			});
			expect(forkProbe?.status).toBe("pending");
			expect(forkProbe?.outputJson).toBeNull();
			expect(getNarraforkHome()).toBe(directory);
		} finally {
			mock.module("../../lib/agent", () => realAgent);
			if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = previousHome;
			resetRestartRecoveryForTests();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("an interrupted unshared partial drops text and reasoning but keeps the row", async () => {
		const saved = await narratorPersistence.persistAssistantMessage("owner", {
			session_id: "output-test",
			uuid: "test-interrupted",
			message: { content: [{ type: "text", text: "unfinished", completed: false }] },
		});
		expect(await cleanupIncompleteNarratorOutput("owner")).toEqual({
			messageId: saved.id,
			removedBlocks: 1,
		});
		expect(message(saved.id)).toEqual({
			content: [],
			text: null,
			chars: measureMessageCharacters("assistant", [], null),
		});
	});
});
