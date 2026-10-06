import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	fileChangeOperations,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const { retryLastMessage } = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const scopedRevert = await import("../narrator-scoped-revert");
const snapshotRevert = await import("../snapshot-revert");
const localRevert = await import("../revert-planner-local-access");

const ID = "retry-history-only";
const NOW = "2026-09-30T00:00:00.000Z";
let cwd: string;
let path: string;

function message(
	id: string,
	seq: number,
	role: "user" | "assistant" | "sys" | "disp",
	blocks: unknown[] = [],
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: ID,
			role,
			contentJson: blocks,
			contentText: role === "user" ? "retry my request" : null,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: ID, messageId: id, seq })
		.run();
}

async function historyOnlyRollback() {
	message("user", 0, "user", [{ type: "text", text: "retry my request" }]);
	message("answer", 1, "assistant", [{ type: "tool_use", id: "edit", name: "Edit" }]);
	db.insert(fileChangeOperations)
		.values({
			id: "recorded-operation",
			sourceInstanceId: "test-instance",
			sourceKind: "tool",
			sourceId: "edit-call",
			attempt: 1,
			narratorId: ID,
			actorSubjectKey: `primary:${ID}`,
			actorJson: {
				kind: "primary",
				subjectKey: `primary:${ID}`,
				narratorId: ID,
				userId: null,
				label: null,
				deleted: false,
				parentSubjectKey: null,
			},
			executionOutcome: "succeeded",
			effectOutcome: "changed",
			settlement: "settled",
			coverage: "complete",
			startedAt: NOW,
			updatedAt: NOW,
			finishedAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "edit-call",
			narratorId: ID,
			messageId: "answer",
			toolUseId: "edit",
			toolName: "Edit",
			inputJson: { file_path: path, old_string: "before", new_string: "kept" },
			status: "success",
			fileChangeOperationId: "recorded-operation",
			executionDeviceId: "local",
			executionCwd: cwd,
			executionPathFlavor: "posix",
			resolvedFilePath: path,
			createdAt: NOW,
		})
		.run();
	await narratorService.deleteMessagesAfter(ID, "user", { skipRevert: true });
	return evidence();
}

function evidence() {
	return {
		messages: db.select().from(narratorMessages).where(eq(narratorMessages.role, "disp")).all(),
		refs: db
			.select()
			.from(narratorMessageRefs)
			.all()
			.filter((ref) => ref.segmentCompactId !== null),
		tools: db.select().from(narratorToolCalls).all(),
	};
}

function stopAtModelStart() {
	// Exercise the real retry and database cleanup, but never send a provider request.
	activeNarrators.set(ID, {
		narratorId: ID,
		conversationId: "test",
		cwd,
		model: "test:model",
		provider: "test",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	});
	const reachedStart = new Error("test reached model start");
	const start = spyOn(narratorService, "updateStatus").mockImplementation(async (_id, status) => {
		expect(status).toBe("working");
		throw reachedStart;
	});
	return { start, reachedStart };
}

beforeEach(() => {
	cleanDb(sqlite);
	cwd = mkdtempSync(join(tmpdir(), "nf-retry-history-"));
	path = join(cwd, "kept.txt");
	writeFileSync(path, "kept file bytes\n");
	db.insert(narrators)
		.values({ id: ID, cwd, status: "idle", createdAt: NOW, updatedAt: NOW })
		.run();
});
afterEach(() => {
	activeNarrators.delete(ID);
	mock.restore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(() => {
	mock.module("../../db", () => realDb);
});

describe("retry after history-only rollback", () => {
	for (const trailingNoise of [false, true]) {
		test(`reaches model start without touching files or checkpoint identity (noise=${trailingNoise})`, async () => {
			const kept = await historyOnlyRollback();
			expect(kept.tools).toHaveLength(1);
			expect(kept.tools[0]?.fileChangeOperationId).toBe("recorded-operation");
			if (trailingNoise) {
				message("empty-assistant", 2, "assistant");
				message("notice", 3, "sys", [{ type: "text", text: "background notice" }]);
			}
			const scoped = spyOn(scopedRevert, "revertNarratorScopedForMessages");
			const workspace = spyOn(snapshotRevert, "revertForMessagesTree");
			const apply = spyOn(localRevert, "applyLocalRevertPlan");
			const { start, reachedStart } = stopAtModelStart();
			for (let retry = 0; retry < 2; retry++) {
				await expect(retryLastMessage(ID)).rejects.toBe(reachedStart);
				expect(evidence()).toEqual(kept);
				expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
			}
			expect(start).toHaveBeenCalledTimes(2);
			expect(scoped).not.toHaveBeenCalled();
			expect(workspace).not.toHaveBeenCalled();
			expect(apply).not.toHaveBeenCalled();
			expect(
				db
					.select()
					.from(narratorMessages)
					.all()
					.map((row) => row.id)
					.sort(),
			).toEqual(["user", ...kept.messages.map((row) => row.id)].sort());
		});
	}

	test("history-only range deletion preserves existing checkpoints rather than cloning them", async () => {
		const kept = await historyOnlyRollback();
		for (let retry = 0; retry < 2; retry++) {
			const result = await narratorService.deleteMessagesAfter(ID, "user", { skipRevert: true });
			expect(result.deletedMessageIds).toEqual([]);
			expect(evidence()).toEqual(kept);
		}
		// Explicit file rollback still sees the evidence; it must not disappear globally.
		await expect(narratorService.deleteMessagesAfter(ID, "user")).rejects.toThrow(
			"execution_unavailable",
		);
		expect(evidence()).toEqual(kept);
		expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
	});

	test("only internal checkpoints survive, not ordinary compacted or shared history", async () => {
		const kept = await historyOnlyRollback();
		db.insert(narrators).values({ id: "fork", cwd, createdAt: NOW, updatedAt: NOW }).run();
		const checkpoint = kept.refs[0];
		if (!checkpoint) throw new Error("missing checkpoint");
		db.insert(narratorMessageRefs)
			.values({ ...checkpoint, id: "fork-checkpoint", narratorId: "fork" })
			.run();
		message("compacted", 2, "assistant", [{ type: "text", text: "compacted answer" }]);
		db.update(narratorMessageRefs)
			.set({ segmentCompactId: "compacted" })
			.where(eq(narratorMessageRefs.messageId, "compacted"))
			.run();
		message("lookalike", 3, "disp", [{ type: "file_history_checkpoint" }]);
		message("other-disp", 4, "disp", [{ type: "text", text: "not file evidence" }]);
		db.update(narratorMessageRefs)
			.set({ segmentCompactId: "other-disp" })
			.where(eq(narratorMessageRefs.messageId, "other-disp"))
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "fork-answer", narratorId: "fork", messageId: "compacted", seq: 2 })
			.run();
		const forkRefs = db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "fork"))
			.all();
		const result = await narratorService.deleteMessagesAfter(ID, "user", { skipRevert: true });
		expect(result.deletedMessageIds).toEqual(["compacted", "lookalike", "other-disp"]);
		expect(
			db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "fork")).all(),
		).toEqual(forkRefs);
		expect(
			db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.id, checkpoint.id)).get(),
		).toEqual(checkpoint);
		expect(evidence().tools).toEqual(kept.tools);
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, "compacted")).get(),
		).toBeDefined();
		expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
	});

	test("retry still refuses a real assistant answer without touching its history", async () => {
		const kept = await historyOnlyRollback();
		message("real-answer", 2, "assistant", [{ type: "text", text: "a real answer" }]);
		const { start } = stopAtModelStart();
		await expect(retryLastMessage(ID)).rejects.toThrow("Last message is not a user message");
		expect(start).not.toHaveBeenCalled();
		expect(evidence()).toEqual(kept);
		expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
	});
});
