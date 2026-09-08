import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { testEnvironment } from "../../../tests/preload";
import { db, sqlite } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { batchDeleteBlocksSchema } from "../../lib/validators/narrators";
import * as scopedRevert from "../narrator-scoped-revert";
import { narratorService } from "../narrator-service";
import * as snapshotRevert from "../snapshot-revert";

const narratorIds: string[] = [];
const directories: string[] = [];
const triggerNames: string[] = [];
const now = "2026-09-07T00:00:00.000Z";

type Block = { type: string; id?: string; name?: string; text?: string };

function fixture() {
	// Importing the real DB is safe only because bunfig's preload ran first.
	expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
	expect(process.env.HOME).toBe(testEnvironment.isolatedHome);
	expect(testEnvironment.narraforkHome).not.toBe(testEnvironment.realNarraforkHome);
	const cwd = mkdtempSync(join(tmpdir(), "nf-history-safety-"));
	directories.push(cwd);
	const narratorId = addNarrator(cwd);
	return { cwd, narratorId };
}

function addNarrator(cwd: string) {
	const narratorId = generateId();
	db.insert(narrators)
		.values({
			id: narratorId,
			cwd,
			status: "idle",
			apiConversationId: "keep-until-commit",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	narratorIds.push(narratorId);
	return narratorId;
}

function addMessage(narratorId: string, contentJson: Block[], seq = 1) {
	const messageId = generateId();
	db.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson, createdAt: now })
		.run();
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq }).run();
	return messageId;
}

function addTool(narratorId: string, messageId: string, toolUseId: string, filePath: string) {
	const id = generateId();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: { file_path: filePath, content: "changed\n" },
			status: "success",
			executionDeviceId: "local",
			executionCwd: join(filePath, ".."),
			executionPathFlavor: "posix",
			resolvedFilePath: filePath,
			createdAt: now,
		})
		.run();
	return id;
}

function addAgentCall(narratorId: string, messageId: string, toolUseId: string) {
	const id = addTool(narratorId, messageId, toolUseId, "unused-agent-path");
	db.update(narratorToolCalls)
		.set({ toolName: "Agent", inputJson: {}, executionIdentityVersion: 1 })
		.where(eq(narratorToolCalls.id, id))
		.run();
	return id;
}

function addChild(cwd: string, parentNarratorId: string, originToolCallId: string | null) {
	const id = addNarrator(cwd);
	db.update(narrators)
		.set({ type: "subagent", variant: "subagent:general", parentNarratorId, originToolCallId })
		.where(eq(narrators.id, id))
		.run();
	return id;
}

function childMessage(narratorId: string, toolUseId: string, text: string, referenced = false) {
	const id = addMessage(narratorId, [{ type: "text", text }]);
	db.update(narratorMessages)
		.set({ parentToolUseId: toolUseId })
		.where(eq(narratorMessages.id, id))
		.run();
	if (!referenced)
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, id)).run();
	return id;
}

function messageRefs(messageId: string) {
	return db
		.select({
			id: narratorMessageRefs.id,
			narratorId: narratorMessageRefs.narratorId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.messageId, messageId))
		.orderBy(narratorMessageRefs.id)
		.all();
}

function messageBlocks(messageId: string) {
	return db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, messageId) }).sync()
		?.contentJson;
}

function narratorState(narratorId: string) {
	return db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) }).sync();
}

/**
 * Only the rollback planner is stubbed: history/COW/SQL and file compensation are
 * real. M0 refuses legacy evidence, so these tests must not manufacture tree hashes
 * to pretend the legacy planner has trustworthy ownership evidence.
 */
function allowTestRollback(paths: Map<string, string>) {
	return spyOn(scopedRevert, "revertNarratorScopedForToolUses").mockImplementation(
		async (narratorId, toolUses) =>
			snapshotRevert.applyDeviceFileStates(
				narratorId,
				toolUses.map(({ toolUseId }) => {
					const filePath = paths.get(toolUseId);
					if (!filePath) throw new Error(`Unexpected rollback target: ${toolUseId}`);
					return { deviceId: "local", filePath, pathFlavor: "posix", content: "base\n" };
				}),
			),
	);
}

function failSecondMessageDelete(messageId: string) {
	const name = `history_fail_${generateId().replaceAll("-", "_")}`;
	// The ID and trigger name are generated locally, never user-supplied SQL.
	sqlite.run(`CREATE TEMP TRIGGER "${name}" BEFORE DELETE ON narrator_messages
		WHEN OLD.id = '${messageId}' BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`);
	triggerNames.push(name);
}

afterEach(() => {
	mock.restore();
	for (const name of triggerNames.splice(0)) sqlite.run(`DROP TRIGGER IF EXISTS "${name}"`);
	if (narratorIds.length > 0) {
		db.update(narrators)
			.set({ forkMessageId: null, pruneBoundaryMessageId: null, parentNarratorId: null })
			.where(inArray(narrators.id, narratorIds))
			.run();
		db.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, narratorIds))
			.run();
		db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, narratorIds)).run();
		db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, narratorIds)).run();
		db.delete(narrators)
			.where(inArray(narrators.id, narratorIds.splice(0)))
			.run();
	}
	for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("history-only deletion cannot cross reused provider IDs", () => {
	for (const method of ["deleteMessage", "deleteMessagesAfter"] as const) {
		test(`${method} preserves a different narrator's child-shaped message`, async () => {
			const { narratorId, cwd } = fixture();
			const foreignNarratorId = addNarrator(cwd);
			const boundary = addMessage(narratorId, [{ type: "text", text: "keep" }], 1);
			const selected = addMessage(
				narratorId,
				[{ type: "tool_use", id: "reused-provider-call", name: "Write" }],
				2,
			);
			addTool(narratorId, selected, "reused-provider-call", join(cwd, "selected.txt"));
			const foreign = addMessage(
				foreignNarratorId,
				[{ type: "text", text: "another session must keep this" }],
				1,
			);
			db.update(narratorMessages)
				.set({ parentToolUseId: "reused-provider-call" })
				.where(eq(narratorMessages.id, foreign))
				.run();
			const original = messageBlocks(foreign);
			const originalRefs = messageRefs(foreign);
			const originalState = narratorState(foreignNarratorId);
			const foreignPath = join(cwd, "foreign.txt");
			writeFileSync(foreignPath, "foreign bytes must not move\n");
			if (method === "deleteMessage")
				await narratorService.deleteMessage(narratorId, selected, { skipRevert: true });
			else await narratorService.deleteMessagesAfter(narratorId, boundary, { skipRevert: true });
			expect(messageBlocks(foreign)).toEqual(original);
			expect(messageRefs(foreign)).toEqual(originalRefs);
			expect(narratorState(foreignNarratorId)).toEqual(originalState);
			expect(readFileSync(foreignPath, "utf8")).toBe("foreign bytes must not move\n");
			expect(
				db
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, foreignNarratorId),
							eq(narratorMessageRefs.messageId, foreign),
						),
					)
					.get(),
			).toBeDefined();
		});
	}
});

describe("origin-bound derived history cleanup", () => {
	for (const method of ["deleteMessage", "deleteMessagesAfter", "deleteMessageBlocks"] as const) {
		test(`${method} follows the exact tool PK among repeated provider IDs`, async () => {
			const { narratorId, cwd } = fixture();
			const providerId = "same-provider-id-in-two-messages";
			const first = addMessage(
				narratorId,
				[{ type: "tool_use", id: providerId, name: "Agent" }],
				1,
			);
			const selected = addMessage(
				narratorId,
				[{ type: "tool_use", id: providerId, name: "Agent" }],
				2,
			);
			const firstCall = addAgentCall(narratorId, first, providerId);
			const selectedCall = addAgentCall(narratorId, selected, providerId);
			const firstChild = addChild(cwd, narratorId, firstCall);
			const selectedChild = addChild(cwd, narratorId, selectedCall);
			const keep = childMessage(firstChild, providerId, "earlier call's orphan must survive");
			const remove = childMessage(selectedChild, providerId, "selected origin orphan");
			const ordinaryFork = addNarrator(cwd);
			db.update(narrators)
				.set({ parentNarratorId: narratorId, originToolCallId: selectedCall })
				.where(eq(narrators.id, ordinaryFork))
				.run();
			const forkMessage = childMessage(ordinaryFork, providerId, "primary fork is never a child");
			const legacyChild = addChild(cwd, narratorId, null);
			const legacyMessage = childMessage(legacyChild, providerId, "origin unknown");
			const state = narratorState(firstChild);
			const result =
				method === "deleteMessage"
					? await narratorService.deleteMessage(narratorId, selected, { skipRevert: true })
					: method === "deleteMessagesAfter"
						? await narratorService.deleteMessagesAfter(narratorId, first, { skipRevert: true })
						: await narratorService.deleteMessageBlocks(
								narratorId,
								[
									{ messageId: selected, blockIndex: 0 },
									{ messageId: selected, blockIndex: 0 },
								],
								{ skipRevert: true },
							);
			expect(messageBlocks(remove)).toBeUndefined();
			expect(messageBlocks(keep)).toEqual([
				{ type: "text", text: "earlier call's orphan must survive" },
			]);
			expect(messageBlocks(first)).toBeDefined();
			expect(messageBlocks(forkMessage)).toBeDefined();
			expect(messageBlocks(legacyMessage)).toBeDefined();
			expect(narratorState(firstChild)).toEqual(state);
			expect(result.historyWarnings).toContainEqual({
				code: "DERIVED_HISTORY_RETAINED",
				reason: "legacy_origin_unverified",
				toolCallId: selectedCall,
			});
			expect(narratorState(narratorId)?.messageVersion).toBe(1);
		});

		test(`${method} preserves true child refs, shared fork refs and their nested boundary`, async () => {
			const { narratorId, cwd } = fixture();
			const boundary = addMessage(narratorId, [{ type: "text", text: "boundary" }], 0);
			const providerId = "agent-child-with-refs";
			const selected = addMessage(narratorId, [
				{ type: "tool_use", id: providerId, name: "Agent" },
			]);
			const origin = addAgentCall(narratorId, selected, providerId);
			const child = addChild(cwd, narratorId, origin);
			const kept = childMessage(child, providerId, "child has its own history", true);
			const fork = addNarrator(cwd);
			db.insert(narratorMessageRefs)
				.values({ id: generateId(), narratorId: fork, messageId: kept, seq: 7 })
				.run();
			const nestedTool = addAgentCall(child, kept, "nested-provider");
			const nested = addChild(cwd, child, nestedTool);
			const nestedMessage = childMessage(
				nested,
				"nested-provider",
				"unreferenced but behind retained history",
			);
			const refs = messageRefs(kept);
			const childState = narratorState(child);
			const forkState = narratorState(fork);
			const path = join(cwd, "actual-child.txt");
			writeFileSync(path, "child's retained bytes\n");
			const result =
				method === "deleteMessage"
					? await narratorService.deleteMessage(narratorId, selected, { skipRevert: true })
					: method === "deleteMessagesAfter"
						? await narratorService.deleteMessagesAfter(narratorId, boundary, { skipRevert: true })
						: await narratorService.deleteMessageBlocks(
								narratorId,
								[{ messageId: selected, blockIndex: 0 }],
								{ skipRevert: true },
							);
			expect(messageBlocks(selected)).toBeUndefined();
			expect(messageBlocks(kept)).toEqual([{ type: "text", text: "child has its own history" }]);
			expect(messageRefs(kept)).toEqual(refs);
			expect(messageBlocks(nestedMessage)).toBeDefined();
			expect(narratorState(child)).toEqual(childState);
			expect(narratorState(fork)).toEqual(forkState);
			expect(readFileSync(path, "utf8")).toBe("child's retained bytes\n");
			expect(result.historyWarnings).toContainEqual({
				code: "DERIVED_HISTORY_RETAINED",
				reason: "referenced",
				toolCallId: origin,
				messageId: kept,
			});
		});
	}

	test("legacy same-narrator inline history is retained, not selected by a repeated block ID", async () => {
		const { narratorId, cwd } = fixture();
		const providerId = "legacy-repeated";
		const selected = addMessage(
			narratorId,
			[{ type: "tool_use", id: providerId, name: "Agent" }],
			3,
		);
		const origin = addAgentCall(narratorId, selected, providerId);
		const inline = childMessage(narratorId, providerId, "legacy inline own ref", true);
		const originalRefs = messageRefs(inline);
		const foreign = addNarrator(cwd);
		const foreignMessage = childMessage(foreign, providerId, "foreign primary own ref", true);
		const result = await narratorService.deleteMessageBlocks(
			narratorId,
			[
				{ messageId: selected, blockIndex: 0 },
				{ messageId: selected, blockIndex: 0 },
			],
			{ skipRevert: true },
		);
		expect(result.deleted).toBe(1);
		expect(messageBlocks(inline)).toBeDefined();
		expect(messageRefs(inline)).toEqual(originalRefs);
		expect(messageBlocks(foreignMessage)).toBeDefined();
		expect(result.historyWarnings).toContainEqual({
			code: "DERIVED_HISTORY_RETAINED",
			reason: "legacy_origin_unverified",
			toolCallId: origin,
			messageId: inline,
		});
	});

	test("nested cleanup follows real unreferenced origins and retains their file checkpoints", async () => {
		const { narratorId, cwd } = fixture();
		const selected = addMessage(narratorId, [{ type: "tool_use", id: "outer", name: "Agent" }]);
		const origin = addAgentCall(narratorId, selected, "outer");
		const child = addChild(cwd, narratorId, origin);
		const childId = childMessage(child, "outer", "orphan child");
		const nestedCall = addAgentCall(child, childId, "nested");
		const nested = addChild(cwd, child, nestedCall);
		const nestedId = childMessage(nested, "nested", "orphan nested child");
		const path = join(cwd, "nested.txt");
		writeFileSync(path, "nested bytes\n");
		addTool(nested, nestedId, "nested-write", path);
		await narratorService.deleteMessage(narratorId, selected, { skipRevert: true });
		expect(messageBlocks(childId)).toBeUndefined();
		expect(messageBlocks(nestedId)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe("nested bytes\n");
		const checkpoints = db.query.narratorToolCalls
			.findMany({
				where: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.isFileHistoryCheckpoint, true),
				),
			})
			.sync();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0].resolvedFilePath).toBe(path);
	});

	test("a shared parent and its COW origin cannot strand an unreferenced child", async () => {
		const { narratorId, cwd } = fixture();
		const selected = addMessage(narratorId, [
			{ type: "text", text: "copy only this away" },
			{ type: "tool_use", id: "cow-agent", name: "Agent" },
		]);
		const origin = addAgentCall(narratorId, selected, "cow-agent");
		const child = addChild(cwd, narratorId, origin);
		const childId = childMessage(child, "cow-agent", "shared child evidence");
		const fork = addNarrator(cwd);
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: fork, messageId: selected, seq: 1 })
			.run();
		await narratorService.deleteMessageBlock(fork, selected, 0, { skipRevert: true });
		const copiedRef = db.query.narratorMessageRefs
			.findFirst({ where: eq(narratorMessageRefs.narratorId, fork) })
			.sync();
		const copiedCall = db.query.narratorToolCalls
			.findFirst({ where: eq(narratorToolCalls.messageId, copiedRef?.messageId ?? "missing") })
			.sync();
		expect(copiedCall?.executionOriginToolCallId).toBe(origin);
		const result = await narratorService.deleteMessage(narratorId, selected, { skipRevert: true });
		expect(messageBlocks(childId)).toBeDefined();
		expect(messageBlocks(copiedRef?.messageId ?? "missing")).toBeDefined();
		expect(result.historyWarnings).toContainEqual({
			code: "DERIVED_HISTORY_RETAINED",
			reason: "shared_parent",
			toolCallId: origin,
		});
	});

	test("range and derived child row budgets reject before deleting any history", async () => {
		const { narratorId, cwd } = fixture();
		const selected = addMessage(narratorId, [
			{ type: "tool_use", id: "many-children", name: "Agent" },
		]);
		const origin = addAgentCall(narratorId, selected, "many-children");
		const child = addChild(cwd, narratorId, origin);
		db.transaction((tx) => {
			for (let index = 0; index < 5_001; index++)
				tx.insert(narratorMessages)
					.values({
						id: generateId(),
						narratorId: child,
						parentToolUseId: "many-children",
						role: "assistant",
						contentJson: [],
						createdAt: now,
					})
					.run();
		});
		await expect(
			narratorService.deleteMessage(narratorId, selected, { skipRevert: true }),
		).rejects.toThrow(/safety budget/);
		expect(messageBlocks(selected)).toBeDefined();
		expect(messageRefs(selected)).toHaveLength(1);
		expect(narratorState(narratorId)?.messageVersion).toBe(0);
	});

	test("an oversized caller ref range is rejected before loading message bodies", async () => {
		const { narratorId } = fixture();
		const boundary = addMessage(narratorId, [{ type: "text", text: "boundary" }], 0);
		db.transaction((tx) => {
			for (let index = 0; index < 5_001; index++) {
				const id = generateId();
				tx.insert(narratorMessages)
					.values({ id, narratorId, role: "assistant", contentJson: [], createdAt: now })
					.run();
				tx.insert(narratorMessageRefs)
					.values({ id: generateId(), narratorId, messageId: id, seq: index + 1 })
					.run();
			}
		});
		await expect(
			narratorService.deleteMessagesAfter(narratorId, boundary, { skipRevert: true }),
		).rejects.toThrow(/safety budget/);
		expect(narratorState(narratorId)?.messageVersion).toBe(0);
		expect(messageRefs(boundary)).toHaveLength(1);
	});

	test("missing tool-call rows preserve legacy child-shaped history with an explicit warning", async () => {
		const { narratorId } = fixture();
		const selected = addMessage(
			narratorId,
			[{ type: "tool_use", id: "missing-tool-row", name: "Agent" }],
			2,
		);
		const inline = childMessage(narratorId, "missing-tool-row", "no immutable origin", true);
		const result = await narratorService.deleteMessage(narratorId, selected, { skipRevert: true });
		expect(messageBlocks(inline)).toBeDefined();
		expect(result.historyWarnings).toContainEqual({
			code: "DERIVED_HISTORY_RETAINED",
			reason: "legacy_origin_unverified",
			messageId: selected,
			toolUseId: "missing-tool-row",
		});
	});

	test("oversized checkpoint data is rejected by metadata before the history transaction writes", async () => {
		const { narratorId, cwd } = fixture();
		const selected = addMessage(narratorId, [
			{ type: "tool_use", id: "large-write", name: "Write" },
		]);
		const call = addTool(narratorId, selected, "large-write", join(cwd, "large.txt"));
		db.update(narratorToolCalls)
			.set({ outputJson: "x".repeat(4 * 1024 * 1024) })
			.where(eq(narratorToolCalls.id, call))
			.run();
		await expect(
			narratorService.deleteMessage(narratorId, selected, { skipRevert: true }),
		).rejects.toThrow(/safety budget/);
		expect(messageBlocks(selected)).toBeDefined();
		expect(messageRefs(selected)).toHaveLength(1);
	});

	for (const method of ["deleteMessage", "deleteMessagesAfter"] as const) {
		test(`${method} rolls back refs, descendant cleanup and checkpoints on a DB failure`, async () => {
			const { narratorId, cwd } = fixture();
			const boundary = addMessage(narratorId, [{ type: "text", text: "keep" }], 0);
			const selected = addMessage(narratorId, [
				{ type: "tool_use", id: "failing-origin", name: "Agent" },
			]);
			const origin = addAgentCall(narratorId, selected, "failing-origin");
			const child = addChild(cwd, narratorId, origin);
			const childId = childMessage(child, "failing-origin", "keep after SQL failure");
			const path = join(cwd, "failure.txt");
			writeFileSync(path, "unchanged bytes\n");
			addTool(child, childId, "child-write", path);
			const refs = messageRefs(selected);
			failSecondMessageDelete(childId);
			const result =
				method === "deleteMessage"
					? narratorService.deleteMessage(narratorId, selected, { skipRevert: true })
					: narratorService.deleteMessagesAfter(narratorId, boundary, { skipRevert: true });
			await expect(result).rejects.toThrow(/injected history failure/);
			expect(messageBlocks(selected)).toBeDefined();
			expect(messageBlocks(childId)).toBeDefined();
			expect(messageRefs(selected)).toEqual(refs);
			expect(narratorState(narratorId)?.messageVersion).toBe(0);
			expect(readFileSync(path, "utf8")).toBe("unchanged bytes\n");
			expect(
				db.query.narratorToolCalls
					.findMany({
						where: and(
							eq(narratorToolCalls.narratorId, narratorId),
							eq(narratorToolCalls.isFileHistoryCheckpoint, true),
						),
					})
					.sync(),
			).toHaveLength(0);
		});
	}
});

describe("fixed block selection and shared-message COW", () => {
	test("two tools plus text are deleted with one COW while the shared original survives", async () => {
		const { narratorId, cwd } = fixture();
		const forkId = addNarrator(cwd);
		const toolA = generateId();
		const toolB = generateId();
		const original: Block[] = [
			{ type: "tool_use", id: toolA, name: "Write" },
			{ type: "text", text: "remove" },
			{ type: "tool_use", id: toolB, name: "Write" },
			{ type: "text", text: "keep" },
		];
		const messageId = addMessage(narratorId, original);
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: forkId, messageId, seq: 1 })
			.run();
		db.update(narrators).set({ forkMessageId: messageId }).where(eq(narrators.id, forkId)).run();
		const a = join(cwd, "a.txt");
		const b = join(cwd, "b.txt");
		writeFileSync(a, "changed\n");
		writeFileSync(b, "changed\n");
		addTool(narratorId, messageId, toolA, a);
		addTool(narratorId, messageId, toolB, b);
		const revert = allowTestRollback(
			new Map([
				[toolA, a],
				[toolB, b],
			]),
		);

		const result = await narratorService.deleteMessageBlocks(forkId, [
			{ messageId, blockIndex: 0 },
			{ messageId, blockIndex: 1 },
			{ messageId, blockIndex: 2 },
		]);

		expect(result).toMatchObject({ deleted: 3, failed: 0 });
		expect(revert).toHaveBeenCalledTimes(1);
		expect(revert.mock.calls[0]?.[1]).toEqual([
			{ messageId, toolUseId: toolB },
			{ messageId, toolUseId: toolA },
		]);
		const refs = db.query.narratorMessageRefs
			.findMany({ where: eq(narratorMessageRefs.narratorId, forkId) })
			.sync();
		expect(refs).toHaveLength(1);
		const newId = refs[0].messageId;
		expect(newId).not.toBe(messageId);
		expect(messageBlocks(newId)).toEqual([{ type: "text", text: "keep" }]);
		expect(messageBlocks(messageId)).toEqual(original);
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).all(),
		).toHaveLength(2);
		expect(
			db.query.narratorToolCalls
				.findMany({ where: eq(narratorToolCalls.messageId, messageId) })
				.sync(),
		).toHaveLength(2);
		expect(
			db.query.narratorToolCalls.findMany({ where: eq(narratorToolCalls.messageId, newId) }).sync(),
		).toHaveLength(0);
		expect(narratorState(forkId)?.forkMessageId).toBe(newId);
		expect(narratorState(forkId)?.messageVersion).toBe(1);
		expect(narratorState(narratorId)?.messageVersion).toBe(0);
		expect(readFileSync(a, "utf8")).toBe("base\n");
		expect(readFileSync(b, "utf8")).toBe("base\n");
	});

	test("COW retains unselected tool evidence after the source history is deleted", async () => {
		const { narratorId, cwd } = fixture();
		const forkId = addNarrator(cwd);
		const toolUseId = generateId();
		const original = [
			{ type: "text", text: "remove" },
			{ type: "tool_use", id: toolUseId },
		];
		const messageId = addMessage(narratorId, original);
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: forkId, messageId, seq: 1 })
			.run();
		const callId = addTool(narratorId, messageId, toolUseId, join(cwd, "retained.txt"));
		// These hashes are only clone payloads, never evidence used for a rollback.
		db.update(narratorToolCalls)
			.set({
				treeHashBefore: "legacy-before",
				treeHashAfter: "legacy-after",
				ownedPathsJson: ["retained.txt"],
			})
			.where(eq(narratorToolCalls.id, callId))
			.run();
		await narratorService.deleteMessageBlocks(
			forkId,
			[
				{ messageId, blockIndex: 0 },
				{ messageId, blockIndex: 0 },
			],
			{ skipRevert: true },
		);
		const copiedRef = db.query.narratorMessageRefs
			.findFirst({ where: eq(narratorMessageRefs.narratorId, forkId) })
			.sync();
		const copiedCall = db.query.narratorToolCalls
			.findFirst({ where: eq(narratorToolCalls.messageId, copiedRef?.messageId ?? "missing") })
			.sync();
		expect(copiedCall).toMatchObject({
			toolUseId,
			treeHashBefore: "legacy-before",
			treeHashAfter: "legacy-after",
			ownedPathsJson: ["retained.txt"],
		});
		expect(copiedCall?.id).not.toBe(callId);
		await narratorService.deleteMessageBlocks(
			narratorId,
			[
				{ messageId, blockIndex: 0 },
				{ messageId, blockIndex: 1 },
			],
			{ skipRevert: true },
		);
		expect(messageBlocks(copiedRef?.messageId ?? "missing")).toEqual([
			{ type: "tool_use", id: toolUseId },
		]);
		expect(
			db.query.narratorToolCalls
				.findFirst({ where: eq(narratorToolCalls.id, copiedCall?.id ?? "missing") })
				.sync(),
		).toBeDefined();
	});

	test("duplicate indices are removed once by both validator and service", async () => {
		const { narratorId, cwd } = fixture();
		const toolUseId = generateId();
		const original: Block[] = [
			{ type: "tool_use", id: toolUseId },
			{ type: "text", text: "must survive" },
		];
		const messageId = addMessage(narratorId, original);
		const path = join(cwd, "duplicate.txt");
		writeFileSync(path, "changed\n");
		addTool(narratorId, messageId, toolUseId, path);
		const revert = allowTestRollback(new Map([[toolUseId, path]]));
		const selection = [
			{ messageId, blockIndex: 0 },
			{ messageId, blockIndex: 0 },
		];
		expect(batchDeleteBlocksSchema.parse({ blocks: selection }).blocks).toHaveLength(1);
		const result = await narratorService.deleteMessageBlocks(narratorId, selection);
		expect(result).toMatchObject({ deleted: 1, failed: 0 });
		expect(result.results).toHaveLength(1);
		expect(revert.mock.calls[0]?.[1]).toEqual([{ messageId, toolUseId }]);
		expect(messageBlocks(messageId)).toEqual([{ type: "text", text: "must survive" }]);
		expect(readFileSync(path, "utf8")).toBe("base\n");
	});

	test("all blocks and compact markers are prechecked before the rollback writer", async () => {
		const { narratorId, cwd } = fixture();
		const toolUseId = generateId();
		const first = addMessage(narratorId, [{ type: "tool_use", id: toolUseId }]);
		const path = join(cwd, "precheck.txt");
		writeFileSync(path, "changed\n");
		addTool(narratorId, first, toolUseId, path);
		const second = addMessage(narratorId, [{ type: "text", text: "keep" }], 2);
		const revert = allowTestRollback(new Map([[toolUseId, path]]));
		await expect(
			narratorService.deleteMessageBlocks(narratorId, [
				{ messageId: first, blockIndex: 0 },
				{ messageId: second, blockIndex: 3 },
			]),
		).rejects.toThrow(/out of range/);
		db.update(narratorMessages)
			.set({ contentJson: [{ type: "compact", status: "compacting" }] })
			.where(eq(narratorMessages.id, second))
			.run();
		await expect(
			narratorService.deleteMessageBlocks(narratorId, [
				{ messageId: first, blockIndex: 0 },
				{ messageId: second, blockIndex: 0 },
			]),
		).rejects.toThrow(/running compact/);
		expect(revert).not.toHaveBeenCalled();
		expect(messageBlocks(first)).toEqual([{ type: "tool_use", id: toolUseId }]);
		expect(readFileSync(path, "utf8")).toBe("changed\n");
	});

	test("history byte limits apply before file writes, including skipRevert", async () => {
		const { narratorId } = fixture();
		const messageId = addMessage(narratorId, [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }]);
		await expect(
			narratorService.deleteMessageBlocks(narratorId, [{ messageId, blockIndex: 0 }], {
				skipRevert: true,
			}),
		).rejects.toThrow(/safety budget/);
		expect(narratorState(narratorId)?.messageVersion).toBe(0);
	});
});

describe("history rollback refusal and transaction compensation", () => {
	for (const entry of ["messages", "block", "blocks"] as const) {
		test(`${entry}: unavailable narrator rollback never becomes workspace or replay`, async () => {
			const { narratorId, cwd } = fixture();
			const toolUseId = generateId();
			const messageId = addMessage(narratorId, [{ type: "tool_use", id: toolUseId }]);
			const path = join(cwd, "human.txt");
			writeFileSync(path, "user's later bytes\n");
			addTool(narratorId, messageId, toolUseId, path);
			const workspace = spyOn(snapshotRevert, "revertForMessagesTree");
			const replayMessages = spyOn(snapshotRevert, "revertPatchesForMessages");
			const replayBlock = spyOn(snapshotRevert, "revertPatchForToolUse");
			const replayBlocks = spyOn(snapshotRevert, "revertPatchForToolUses");
			const action =
				entry === "messages"
					? narratorService.deleteMessage(narratorId, messageId)
					: entry === "block"
						? narratorService.deleteMessageBlock(narratorId, messageId, 0)
						: narratorService.deleteMessageBlocks(narratorId, [{ messageId, blockIndex: 0 }]);
			await expect(action).rejects.toThrow(/REVERT_UNAVAILABLE/);
			expect(workspace).not.toHaveBeenCalled();
			expect(replayMessages).not.toHaveBeenCalled();
			expect(replayBlock).not.toHaveBeenCalled();
			expect(replayBlocks).not.toHaveBeenCalled();
			expect(readFileSync(path, "utf8")).toBe("user's later bytes\n");
			expect(messageBlocks(messageId)).toEqual([{ type: "tool_use", id: toolUseId }]);
			expect(narratorState(narratorId)?.messageVersion).toBe(0);
		});
	}

	test("an absent legacy result also refuses, rather than treating unavailable as no-op", async () => {
		const { narratorId, cwd } = fixture();
		const toolUseId = generateId();
		const messageId = addMessage(narratorId, [{ type: "tool_use", id: toolUseId }]);
		addTool(narratorId, messageId, toolUseId, join(cwd, "missing.txt"));
		// Simulate the old nullable provider contract at the integration boundary.
		spyOn(scopedRevert, "revertNarratorScopedForToolUses").mockResolvedValue(
			null as unknown as snapshotRevert.RevertResult,
		);
		await expect(narratorService.deleteMessageBlock(narratorId, messageId, 0)).rejects.toThrow(
			/REVERT_UNAVAILABLE/,
		);
		expect(messageBlocks(messageId)).toEqual([{ type: "tool_use", id: toolUseId }]);
	});

	test("workspace scope is only called explicitly, and never falls back to replay", async () => {
		const { narratorId, cwd } = fixture();
		const toolUseId = generateId();
		const messageId = addMessage(narratorId, [{ type: "tool_use", id: toolUseId }]);
		addTool(narratorId, messageId, toolUseId, join(cwd, "workspace.txt"));
		const workspace = spyOn(snapshotRevert, "revertForMessagesTree").mockResolvedValue(null);
		const replay = spyOn(snapshotRevert, "revertPatchesForMessages");
		await expect(
			narratorService.deleteMessage(narratorId, messageId, { scope: "workspace" }),
		).rejects.toThrow(/REVERT_UNAVAILABLE/);
		expect(workspace).toHaveBeenCalledTimes(1);
		expect(replay).not.toHaveBeenCalled();
		await expect(
			narratorService.deleteMessageBlocks(narratorId, [{ messageId, blockIndex: 0 }], {
				scope: "workspace",
			}),
		).rejects.toThrow(/REVERT_UNAVAILABLE/);
		expect(workspace).toHaveBeenCalledTimes(1);
		expect(messageBlocks(messageId)).toEqual([{ type: "tool_use", id: toolUseId }]);
	});

	test("SQL failure after the first deletion rolls back every history row and every file", async () => {
		const { narratorId, cwd } = fixture();
		const paths = new Map<string, string>();
		const selection = [1, 2].map((seq) => {
			const toolUseId = generateId();
			const messageId = addMessage(narratorId, [{ type: "tool_use", id: toolUseId }], seq);
			const path = join(cwd, `${seq}.txt`);
			writeFileSync(path, "changed\n");
			addTool(narratorId, messageId, toolUseId, path);
			paths.set(toolUseId, path);
			return { messageId, blockIndex: 0 };
		});
		allowTestRollback(paths);
		failSecondMessageDelete(selection[1].messageId);
		await expect(narratorService.deleteMessageBlocks(narratorId, selection)).rejects.toThrow(
			/injected history failure/,
		);
		for (const { messageId } of selection) expect(messageBlocks(messageId)).toBeDefined();
		for (const path of paths.values()) expect(readFileSync(path, "utf8")).toBe("changed\n");
		expect(
			db.query.narratorToolCalls
				.findMany({ where: eq(narratorToolCalls.narratorId, narratorId) })
				.sync(),
		).toHaveLength(2);
		expect(narratorState(narratorId)?.messageVersion).toBe(0);
		expect(narratorState(narratorId)?.apiConversationId).toBe("keep-until-commit");
	});

	test("a content change during rollback rejects the stale selection and compensates files", async () => {
		const { narratorId, cwd } = fixture();
		const toolUseId = generateId();
		const messageId = addMessage(narratorId, [
			{ type: "tool_use", id: toolUseId },
			{ type: "text", text: "before" },
		]);
		const path = join(cwd, "stale.txt");
		writeFileSync(path, "changed\n");
		addTool(narratorId, messageId, toolUseId, path);
		const changed = [
			{ type: "text", text: "concurrent edit" },
			{ type: "tool_use", id: toolUseId },
		];
		spyOn(scopedRevert, "revertNarratorScopedForToolUses").mockImplementation(async () => {
			const result = await snapshotRevert.applyDeviceFileStates(narratorId, [
				{ deviceId: "local", filePath: path, content: "base\n" },
			]);
			db.update(narratorMessages)
				.set({ contentJson: changed })
				.where(eq(narratorMessages.id, messageId))
				.run();
			return result;
		});
		await expect(
			narratorService.deleteMessageBlocks(narratorId, [{ messageId, blockIndex: 0 }]),
		).rejects.toThrow(/history changed/);
		expect(messageBlocks(messageId)).toEqual(changed);
		expect(readFileSync(path, "utf8")).toBe("changed\n");
	});

	test("skipRevert preserves a removed child tool's file evidence as a hidden checkpoint", async () => {
		const { narratorId, cwd } = fixture();
		const parentTool = generateId();
		const childTool = generateId();
		const parentId = addMessage(narratorId, [{ type: "tool_use", id: parentTool, name: "Agent" }]);
		const origin = addAgentCall(narratorId, parentId, parentTool);
		// A legacy same-narrator parentToolUseId is not an origin. This positive
		// cleanup fixture uses a real child and a genuinely unreferenced message.
		const childNarratorId = addChild(cwd, narratorId, origin);
		const childId = addMessage(
			childNarratorId,
			[{ type: "tool_use", id: childTool, name: "Write" }],
			2,
		);
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, childId)).run();
		db.update(narratorMessages)
			.set({ parentToolUseId: parentTool })
			.where(eq(narratorMessages.id, childId))
			.run();
		const path = join(cwd, "child.txt");
		writeFileSync(path, "child bytes\n");
		addTool(childNarratorId, childId, childTool, path);
		await narratorService.deleteMessageBlock(narratorId, parentId, 0, { skipRevert: true });
		expect(messageBlocks(parentId)).toBeUndefined();
		expect(messageBlocks(childId)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe("child bytes\n");
		const checkpoints = db.query.narratorToolCalls
			.findMany({
				where: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.isFileHistoryCheckpoint, true),
				),
			})
			.sync();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0].resolvedFilePath).toBe(path);
	});

	test("skipRevert keeps files and spec evidence with one checkpoint per original message", async () => {
		const { narratorId, cwd } = fixture();
		const toolA = generateId();
		const toolB = generateId();
		const messageId = addMessage(narratorId, [
			{ type: "tool_use", id: toolA },
			{ type: "tool_use", id: toolB },
		]);
		const path = join(cwd, "kept.txt");
		writeFileSync(path, "kept user bytes\n");
		addTool(narratorId, messageId, toolA, path);
		addTool(narratorId, messageId, toolB, "spec://tasks.json");
		const revert = spyOn(scopedRevert, "revertNarratorScopedForToolUses");
		await narratorService.deleteMessageBlocks(
			narratorId,
			[
				{ messageId, blockIndex: 0 },
				{ messageId, blockIndex: 1 },
			],
			{ skipRevert: true },
		);
		expect(revert).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe("kept user bytes\n");
		expect(messageBlocks(messageId)).toBeUndefined();
		const checkpoints = db.query.narratorToolCalls
			.findMany({
				where: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.isFileHistoryCheckpoint, true),
				),
			})
			.sync();
		expect(checkpoints).toHaveLength(2);
		expect(new Set(checkpoints.map((call) => call.messageId)).size).toBe(1);
		expect(checkpoints.map((call) => call.resolvedFilePath).sort()).toEqual(
			[path, "spec://tasks.json"].sort(),
		);
		const refs = db.query.narratorMessageRefs
			.findMany({ where: eq(narratorMessageRefs.narratorId, narratorId) })
			.sync();
		expect(refs).toHaveLength(1);
		expect(refs[0].segmentCompactId).toBe(checkpoints[0].messageId);
		expect(refs[0].seq).toBe(1);
	});
});
