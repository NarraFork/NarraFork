import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb, getTestDb, readTestMessageContent } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBlocks,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Preserve the existing service -> persistence import order across their cycle.
const { narratorService } = await import("../narrator-service");
const {
	narratorPersistence,
	snapshotMutableForkMessagesTx,
	extendMutableForkPrefixTx,
	cowEnvelopeTx,
} = await import("../narrator-persistence");
const { readEnvelope } = await import("../narrator-body-writes");
const { narratorMessageQueries } = await import("../narrator-messages");
const { activeNarrators } = await import("../narrator-session-state");
const { ensureAllRefsMaterialized } = await import("../narrator-refs-backfill");
const NOW = "2026-11-14T10:00:00.000Z";

function seedNarrator(id = "source") {
	sqlite
		.prepare(
			`INSERT INTO narrators (id, traits, cwd, created_at, updated_at) VALUES (?, '["standalone"]', ?, ?, ?)`,
		)
		.run(id, testEnvironment.isolatedHome, NOW, NOW);
}

function refsOf(narratorId: string) {
	return db
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(narratorMessageRefs.seq)
		.all();
}

function lastRef(refs: ReturnType<typeof refsOf>) {
	const ref = refs.at(-1);
	if (!ref) throw new Error("Expected a seeded message ref");
	return ref;
}

function versionsOf(narratorId: string) {
	return sqlite
		.prepare("SELECT message_version, model_history_revision FROM narrators WHERE id = ?")
		.get(narratorId);
}

function bodyOf(messageId: string) {
	return readTestMessageContent(sqlite, messageId);
}

function blocksOf(messageId: string) {
	return db
		.select({
			id: narratorBlocks.id,
			origin: narratorBlocks.originBlockId,
			attempt: narratorBlocks.attemptId,
			createdAt: narratorBlocks.createdAt,
			phase: narratorBlocks.phase,
		})
		.from(narratorBlocks)
		.where(eq(narratorBlocks.messageId, messageId))
		.orderBy(narratorBlocks.ordinal)
		.all();
}

function callsOf(messageId: string) {
	return db
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.messageId, messageId))
		.all();
}

function installLivePartial(messageId: string) {
	const controller = new AbortController();
	const active = {
		narratorId: "source",
		abortController: controller,
		conversationId: "conversation",
		cwd: testEnvironment.isolatedHome,
		model: "test",
		provider: "test",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en" as const,
		_enabledOptionalTools: new Set<string>(),
		_disabledTools: new Set<string>(),
		_blockedSkills: { all: false, names: new Set<string>() },
		_partialMessageId: messageId,
		_substatus: new Set<string>(),
	};
	activeNarrators.set("source", active);
	return active;
}

async function openPartial(uuid = "live-uuid") {
	return narratorPersistence.createPartialAssistantMessage("source", {
		uuid,
		session_id: "conversation",
	});
}

async function fork(entry: "full" | "selected", ids: string[]) {
	return entry === "full"
		? narratorService.forkNarrator("source", null, {
				inheritMode: "full",
				forkMessageId: ids.at(-1),
			})
		: narratorService.forkFromMessages("source", ids);
}

beforeEach(() => {
	cleanDb(sqlite);
	seedNarrator();
});
afterEach(() => activeNarrators.delete("source"));
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

for (const entry of ["full", "selected"] as const) {
	describe(`${entry} live history fork`, () => {
		test("cJM79e8M: text/reasoning checkpoints stay private while stable prefix stays shared", async () => {
			const stable = await narratorPersistence.persistUserMessage("source", "stable prefix");
			const partial = await openPartial();
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "reasoning",
				id: "reasoning",
				text: "reasoning before fork",
				revision: 1,
				completed: false,
			});
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "text",
				id: "text",
				text: "text before fork",
				revision: 1,
				completed: true,
			});
			const sourceBlocks = blocksOf(partial.id);
			expect(sourceBlocks.some((block) => block.phase === "open")).toBe(true);
			const child = await fork(entry, [stable.id, partial.id]);
			const childRefs = refsOf(child.id);
			const snapshotId = childRefs.at(-1)?.messageId as string;
			expect(childRefs[0].messageId).toBe(stable.id);
			expect(snapshotId).not.toBe(partial.id);
			expect(child.forkMessageId).toBe(snapshotId);
			expect(refsOf("source").at(-1)?.messageId).toBe(partial.id);
			const snapshot = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, snapshotId),
			});
			expect(snapshot?.authorNarratorId).toBe("source");
			expect(snapshot?.createdAt).toBe(partial.createdAt);
			expect(blocksOf(snapshotId).map((block) => block.origin)).toEqual(
				sourceBlocks.map((block) => block.origin ?? block.id),
			);
			expect(blocksOf(snapshotId).map((block) => block.createdAt)).toEqual(
				sourceBlocks.map((block) => block.createdAt),
			);
			const frozenBody = bodyOf(snapshotId);
			const frozenVersions = versionsOf(child.id);
			for (const type of ["text", "reasoning"] as const) {
				await narratorPersistence.appendBlockToMessage(partial.id, "source", {
					type,
					id: type,
					text: `${type} after fork`,
					revision: 2,
					completed: true,
				});
			}
			expect(bodyOf(snapshotId)).toEqual(frozenBody);
			expect(bodyOf(partial.id)).not.toEqual(frozenBody);
			expect(versionsOf(child.id)).toEqual(frozenVersions);
			const page = await narratorMessageQueries.getPretextDocumentPage(child.id);
			expect(JSON.stringify(page.messages)).toContain("text before fork");
			expect(JSON.stringify(page.messages)).not.toContain("after fork");
		});

		test("current partial is copied between completed checkpoints without any open block", async () => {
			const partial = await openPartial();
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "text",
				text: "completed checkpoint",
				completed: true,
			});
			expect(blocksOf(partial.id).every((block) => block.phase !== "open")).toBe(true);
			const active = installLivePartial(partial.id);
			const child = await fork(entry, [partial.id]);
			const snapshotId = refsOf(child.id)[0].messageId;
			expect(snapshotId).not.toBe(partial.id);
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "text",
				text: "new block after checkpoint gap",
			});
			expect(JSON.stringify(bodyOf(snapshotId))).not.toContain("checkpoint gap");
			expect(activeNarrators.get("source")).toBe(active);
			expect(active._partialMessageId).toBe(partial.id);
			expect(active.abortController.signal.aborted).toBe(false);
		});

		test("pending ledger identity and continuation stay with source; nested fork keeps the origin", async () => {
			const partial = await openPartial();
			const callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "tool_use",
				id: "live-tool",
				name: "Bash",
				input: { command: "true" },
			});
			expect(callId).toBeString();
			await db
				.update(narratorToolCalls)
				.set({
					status: "pending",
					permissionStartedAt: NOW,
					permissionSuggestions: [{ label: "approve source" }],
				})
				.where(eq(narratorToolCalls.id, callId as string));
			await db.insert(narratorToolContinuations).values({
				id: "continuation",
				toolCallId: callId as string,
				narratorId: "source",
				updateEpoch: "epoch",
				kind: "pending_permission",
				state: "paused",
				createdAt: NOW,
				updatedAt: NOW,
			});
			const sourceCall = callsOf(partial.id)[0];
			// The ledger, not open-block metadata, must also detect older/recovered rows.
			sqlite
				.prepare("UPDATE narrator_blocks SET phase = 'done' WHERE message_id = ?")
				.run(partial.id);
			const child = await fork(entry, [partial.id]);
			const snapshotId = refsOf(child.id)[0].messageId;
			const clone = callsOf(snapshotId)[0];
			expect(clone.id).not.toBe(sourceCall.id);
			expect(clone.executionOriginToolCallId).toBe(sourceCall.id);
			expect(clone.status).toBe("pending");
			expect(clone.executionAttempt).toBe(sourceCall.executionAttempt);
			expect(clone.blockId).not.toBe(sourceCall.blockId);
			expect(callsOf(partial.id)[0]).toEqual(sourceCall);
			expect(db.select().from(narratorToolContinuations).all()).toHaveLength(1);
			expect(db.select().from(narratorToolContinuations).get()?.toolCallId).toBe(sourceCall.id);
			const grandchild = await narratorService.forkNarrator(child.id, "live-uuid", {
				inheritMode: "full",
			});
			const greatGrandchild = await narratorService.forkFromMessages(grandchild.id, [partial.id]);
			const lastSnapshotId = refsOf(greatGrandchild.id)[0].messageId;
			expect(callsOf(lastSnapshotId)[0].executionOriginToolCallId).toBe(sourceCall.id);
			expect(blocksOf(lastSnapshotId)[0].origin).toBe(sourceCall.blockId);
			const resumed = await narratorPersistence.prepareToolCallAttempt(
				"source",
				sourceCall.id,
				true,
			);
			expect(resumed.toolCall.id).toBe(sourceCall.id);
			await expect(
				narratorPersistence.prepareToolCallAttempt(child.id, clone.id, true),
			).rejects.toThrow("COW tool rows cannot authorize");
			const frozenVersion = versionsOf(child.id);
			const frozenBody = bodyOf(snapshotId);
			await narratorPersistence.updateToolCallResult(
				"live-tool",
				{
					status: "success",
					output: "source completed",
					expectedBinding: {
						narratorId: "source",
						toolCallId: sourceCall.id,
						attempt: sourceCall.executionAttempt,
					},
				},
				partial.id,
				sourceCall.id,
			);
			expect(callsOf(partial.id)[0].status).toBe("success");
			expect(callsOf(snapshotId)[0]).toEqual(clone);
			expect(bodyOf(snapshotId)).toEqual(frozenBody);
			expect(versionsOf(child.id)).toEqual(frozenVersion);
			expect(callsOf(lastSnapshotId)[0].status).toBe("pending");
		});

		test("a settled initiating call with an active background task is still copied", async () => {
			const partial = await openPartial();
			const callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "tool_use",
				id: "background-tool",
				name: "Bash",
				input: { command: "true", run_in_background: true },
			});
			await narratorPersistence.updateToolCallResult(
				"background-tool",
				{ status: "success", output: { taskId: "task" } },
				partial.id,
				callId,
			);
			expect(blocksOf(partial.id).every((block) => block.phase !== "open")).toBe(true);
			await db.insert(backgroundTasks).values({
				id: "task",
				parentNarratorId: "source",
				type: "bash",
				status: "running",
				toolCallId: callId as string,
				toolUseId: "background-tool",
				startedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			const child = await fork(entry, [partial.id]);
			expect(refsOf(child.id)[0].messageId).not.toBe(partial.id);
			expect(callsOf(refsOf(child.id)[0].messageId)[0].status).toBe("success");
			expect(db.select().from(backgroundTasks).all()).toHaveLength(1);
		});
	});
}

test("empty live partial snapshots survive source output and fork again by the old coordinate", async () => {
	const partial = await openPartial();
	installLivePartial(partial.id);
	const child = await fork("full", [partial.id]);
	const snapshotId = refsOf(child.id)[0].messageId;
	expect(snapshotId).not.toBe(partial.id);
	expect(bodyOf(snapshotId)).toEqual([]);
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "first checkpoint after fork",
	});
	const grandchild = await narratorService.forkNarrator(child.id, null, {
		inheritMode: "full",
		forkMessageId: partial.id,
	});
	const selected = await narratorService.forkFromMessages(child.id, [partial.id]);
	// No producer owns these empty snapshots, so later generations may share them.
	expect(refsOf(grandchild.id)[0].messageId).toBe(snapshotId);
	expect(refsOf(selected.id)[0].messageId).toBe(snapshotId);
	expect(bodyOf(snapshotId)).toEqual([]);
});

test("an existing legacy fork freezes its ancestor's partial during a closed-block checkpoint gap", async () => {
	const partial = await openPartial();
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "ancestor checkpoint before fork",
		completed: true,
	});
	installLivePartial(partial.id);
	seedNarrator("legacy-fork");
	await db.insert(narratorMessageRefs).values({
		id: "legacy-shared-ref",
		narratorId: "legacy-fork",
		messageId: partial.id,
		seq: 1,
	});
	expect(activeNarrators.get("legacy-fork")).toBeUndefined();
	const child = await narratorService.forkNarrator("legacy-fork", null, { inheritMode: "full" });
	const snapshotId = refsOf(child.id)[0].messageId;
	expect(snapshotId).not.toBe(partial.id);
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "ancestor output after fork",
	});
	expect(JSON.stringify(bodyOf(snapshotId))).not.toContain("after fork");
	expect(refsOf("legacy-fork")[0].messageId).toBe(partial.id);
});

test("duplicate UUID or lineage coordinates are rejected; an actual held message id stays exact", async () => {
	const partial = await openPartial();
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "before",
		completed: false,
	});
	const child = await fork("full", [partial.id]);
	const sibling = await fork("full", [partial.id]);
	const actualId = refsOf(child.id)[0].messageId;
	await db.insert(narratorMessageRefs).values({
		id: "duplicate-uuid-ref",
		narratorId: child.id,
		messageId: refsOf(sibling.id)[0].messageId,
		seq: 2,
	});
	await expect(
		narratorService.forkNarrator(child.id, "live-uuid", { inheritMode: "full" }),
	).rejects.toThrow("ambiguous");
	await expect(narratorService.forkFromMessages(child.id, [partial.id])).rejects.toThrow(
		"ambiguous",
	);
	const exact = await narratorService.forkNarrator(child.id, null, {
		inheritMode: "full",
		forkMessageId: actualId,
	});
	expect(refsOf(exact.id)).toHaveLength(1);
	expect(bodyOf(refsOf(exact.id)[0].messageId)).toEqual(bodyOf(actualId));
});

test("an unrelated producer's same UUID is not accepted as an old source coordinate", async () => {
	const partial = await openPartial();
	installLivePartial(partial.id);
	const child = await fork("full", [partial.id]);
	seedNarrator("unrelated");
	const unrelated = await narratorPersistence.createPartialAssistantMessage("unrelated", {
		uuid: "live-uuid",
		session_id: "unrelated-conversation",
	});
	await expect(
		narratorService.forkNarrator(child.id, null, {
			inheritMode: "full",
			forkMessageId: unrelated.id,
		}),
	).rejects.toThrow("not found in parent narrator");
});

for (const ancestorDepth of [0, 1, 2]) {
	test(`a low-seq background card before compact freezes through ${ancestorDepth} lazy ancestors`, async () => {
		const stable = await narratorPersistence.persistUserMessage("source", "stable old prefix");
		const partial = await openPartial();
		const callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
			type: "tool_use",
			id: "old-background-tool",
			name: "Bash",
			input: { command: "true", run_in_background: true },
		});
		await narratorPersistence.updateToolCallResult(
			"old-background-tool",
			{ status: "success", output: { taskId: "old-task", output: "before fork" } },
			partial.id,
			callId,
		);
		await db.insert(backgroundTasks).values({
			id: "old-task",
			parentNarratorId: "source",
			type: "bash",
			status: "running",
			toolCallId: callId as string,
			toolUseId: "old-background-tool",
			startedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		const marker = await narratorPersistence.persistCompactingMessage("source");
		await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "stable summary");
		const tail = await narratorPersistence.persistUserMessage("source", "tail after compact");
		let parentId = "source";
		for (let depth = 0; depth < ancestorDepth; depth++) {
			// A legacy lazy fork holds only its model tail; the producer still belongs to source.
			const legacyId = `legacy-lazy-${depth}`;
			seedNarrator(legacyId);
			const tailSeq = refsOf("source").at(-1)?.seq as number;
			await db.insert(narratorMessageRefs).values({
				id: `legacy-tail-${depth}`,
				narratorId: legacyId,
				messageId: tail.id,
				seq: tailSeq,
			});
			await db
				.update(narrators)
				.set({
					refsInheritedFrom: parentId,
					refsBackfillCursor: tailSeq,
					forkMessageId: tail.id,
					contextSummary: "stable summary",
				})
				.where(eq(narrators.id, legacyId));
			parentId = legacyId;
		}
		const beforeModel = JSON.stringify(
			await narratorMessageQueries.getModelHistorySinceLastCompact("source"),
		);
		const parentRefsBefore = refsOf(parentId);
		const child = await narratorService.forkNarrator(parentId, null, { inheritMode: "full" });
		expect(child.refsBackfillCursor).toBe(refsOf("source")[1].seq);
		expect(refsOf(child.id).some((ref) => ref.messageId === stable.id)).toBe(false);
		expect(refsOf(parentId)).toEqual(parentRefsBefore);
		await narratorPersistence.updateToolCallResult(
			"old-background-tool",
			{ status: "success", output: { taskId: "old-task", output: "after fork" } },
			partial.id,
			callId,
		);
		await ensureAllRefsMaterialized(child.id);
		const childRefs = refsOf(child.id);
		const snapshotId = childRefs.find((ref) => ref.seq === refsOf("source")[1].seq)
			?.messageId as string;
		expect(snapshotId).toBeString();
		expect(callsOf(snapshotId)[0].outputJson).toEqual({
			taskId: "old-task",
			output: "before fork",
		});
		expect(snapshotId).not.toBe(partial.id);
		expect(callsOf(partial.id)[0].outputJson).toEqual({ taskId: "old-task", output: "after fork" });
		expect(childRefs.filter((ref) => ref.seq === refsOf("source")[1].seq)).toHaveLength(1);
		expect(childRefs.map((ref) => ref.seq)).toEqual(refsOf("source").map((ref) => ref.seq));
		expect(childRefs[0].messageId).toBe(stable.id);
		expect(childRefs.some((ref) => ref.messageId === marker.id)).toBe(true);
		expect(
			JSON.stringify(await narratorMessageQueries.getModelHistorySinceLastCompact(child.id)),
		).toBe(beforeModel);
	});
}

async function seedSettledBackgroundBeforeCompact() {
	const partial = await openPartial();
	const callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "tool_use",
		id: "seek-tool",
		name: "Bash",
		input: {},
	});
	await narratorPersistence.updateToolCallResult(
		"seek-tool",
		{ status: "success", output: "before fork" },
		partial.id,
		callId,
	);
	await db.insert(backgroundTasks).values({
		id: "seek-task",
		parentNarratorId: "source",
		type: "bash",
		status: "running",
		toolUseId: "seek-tool",
		toolCallId: callId as string,
		startedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
	});
	const marker = await narratorPersistence.persistCompactingMessage("source");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
	const tail = await narratorPersistence.persistUserMessage("source", "tail");
	return { partial, callId, marker, tail };
}

for (const detached of [false, true]) {
	test(`a ${detached ? "detached" : "non-lazy"} legacy fork finds the real background producer`, async () => {
		const { partial, callId, marker } = await seedSettledBackgroundBeforeCompact();
		seedNarrator("legacy-shared");
		await db.insert(narratorMessageRefs).values(
			refsOf("source").map((ref) => ({
				...ref,
				id: `legacy-${ref.messageId}`,
				narratorId: "legacy-shared",
				isCompact: ref.messageId === marker.id ? 1 : 0,
			})),
		);
		if (detached) {
			seedNarrator("intermediate");
			await db
				.update(narrators)
				.set({ parentNarratorId: "source", inheritMode: "full" })
				.where(eq(narrators.id, "intermediate"));
		}
		await db
			.update(narrators)
			.set({
				parentNarratorId: detached ? "intermediate" : "source",
				inheritMode: "full",
			})
			.where(eq(narrators.id, "legacy-shared"));
		if (detached) {
			await narratorService.remove("intermediate");
			expect(
				db
					.select({ parent: narrators.parentNarratorId })
					.from(narrators)
					.where(eq(narrators.id, "legacy-shared"))
					.get()?.parent,
			).toBeNull();
		}
		const child = await narratorService.forkNarrator("legacy-shared", null, {
			inheritMode: "full",
		});
		const snapshotId = refsOf(child.id)[0].messageId;
		expect(snapshotId).not.toBe(partial.id);
		await narratorPersistence.updateToolCallResult(
			"seek-tool",
			{ status: "success", output: "after fork" },
			partial.id,
			callId,
		);
		await ensureAllRefsMaterialized(child.id);
		expect(callsOf(snapshotId)[0].outputJson).toBe("before fork");
		expect(callsOf(partial.id)[0].outputJson).toBe("after fork");
	});
}

async function seedCompleteParentChain(depth: number) {
	let parent = "source";
	const summary =
		db
			.select({ summary: narrators.contextSummary })
			.from(narrators)
			.where(eq(narrators.id, "source"))
			.get()?.summary ?? null;
	const copyRefs =
		sqlite.prepare(`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, segment_compact_id)
		SELECT lower(hex(randomblob(16))), ?, message_id, seq, is_compact, segment_compact_id FROM narrator_message_refs WHERE narrator_id = 'source'`);
	for (let index = 0; index < depth; index++) {
		const id = `complete-${index}`;
		seedNarrator(id);
		await db
			.update(narrators)
			.set({ parentNarratorId: parent, inheritMode: "full", contextSummary: summary })
			.where(eq(narrators.id, id));
		copyRefs.run(id);
		parent = id;
	}
	return parent;
}

test("a complete 40-generation parent-only chain fast-returns when there is no old prefix", async () => {
	await narratorPersistence.persistUserMessage("source", "stable");
	const holder = await seedCompleteParentChain(40);
	const held = refsOf(holder);
	const rows = held.map((ref) => ({ ...ref, isCompact: 0, segmentCompactId: null }));
	db.transaction((tx) => {
		const ancestry = spyOn(tx.query.narrators, "findFirst");
		try {
			expect(extendMutableForkPrefixTx(tx, holder, rows, rows[0].seq, [], [], 500)).toBe(rows);
			expect(ancestry).toHaveBeenCalledTimes(1);
		} finally {
			ancestry.mockRestore();
		}
	});
	const child = await narratorService.forkNarrator(holder, null, { inheritMode: "full" });
	expect(refsOf(child.id)).toEqual(held);
	expect(child.refsInheritedFrom).toBeNull();
});

for (const depth of [40, 140]) {
	test(`a complete stable ${depth}-generation parent-only chain forks past compact`, async () => {
		await narratorPersistence.persistUserMessage("source", "stable old history");
		const marker = await narratorPersistence.persistCompactingMessage("source");
		await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
		const tail = await narratorPersistence.persistUserMessage("source", "tail");
		const holder = await seedCompleteParentChain(depth);
		const before = JSON.stringify(
			await narratorMessageQueries.getModelHistorySinceLastCompact(holder),
		);
		const child = await narratorService.forkNarrator(holder, null, { inheritMode: "full" });
		expect(refsOf(child.id).map((ref) => ref.messageId)).toEqual([tail.id]);
		expect(
			JSON.stringify(await narratorMessageQueries.getModelHistorySinceLastCompact(child.id)),
		).toBe(before);
		await ensureAllRefsMaterialized(child.id);
		expect(refsOf(child.id)).toEqual(refsOf("source"));
	});
}

test("exhausted auxiliary provenance discovery still freezes a real producer via bounded owners", async () => {
	const { partial, callId } = await seedSettledBackgroundBeforeCompact();
	const holder = await seedCompleteParentChain(140);
	const child = await narratorService.forkNarrator(holder, null, { inheritMode: "full" });
	const snapshotId = refsOf(child.id)[0].messageId;
	expect(snapshotId).not.toBe(partial.id);
	await narratorPersistence.updateToolCallResult(
		"seek-tool",
		{ status: "success", output: "after fork" },
		partial.id,
		callId,
	);
	await ensureAllRefsMaterialized(child.id);
	expect(callsOf(snapshotId)[0].outputJson).toBe("before fork");
	expect(callsOf(partial.id)[0].outputJson).toBe("after fork");
});

test("producer queries seek parent/status despite large unrelated and completed task histories", async () => {
	await seedSettledBackgroundBeforeCompact();
	seedNarrator("unrelated");
	const unrelatedMessage = await narratorPersistence.persistUserMessage(
		"unrelated",
		"unrelated history",
	);
	const insertTask = sqlite.prepare(
		`INSERT INTO background_tasks (id, parent_narrator_id, type, status, started_at, created_at, updated_at) VALUES (?, ?, 'bash', ?, ?, ?, ?)`,
	);
	const insertCall = sqlite.prepare(
		`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES (?, 'unrelated', ?, ?, 'Bash', 'pending', ?)`,
	);
	db.transaction(() => {
		for (let index = 0; index < 10000; index++) {
			insertTask.run(`other-done-${index}`, "unrelated", "completed", NOW, NOW, NOW);
			insertTask.run(`own-done-${index}`, "source", "completed", NOW, NOW, NOW);
		}
		for (let index = 0; index < 200; index++) {
			insertTask.run(`other-live-${index}`, "unrelated", "running", NOW, NOW, NOW);
			insertCall.run(`other-call-${index}`, unrelatedMessage.id, `other-tool-${index}`, NOW);
		}
	});
	const dialect = new SQLiteSyncDialect();
	const queries: { sql: string; params: unknown[] }[] = [];
	const rows = [{ ...lastRef(refsOf("source")), isCompact: 0, segmentCompactId: null }];
	db.transaction((tx) => {
		const all = tx.all.bind(tx);
		const capture = spyOn(tx, "all").mockImplementation((query) => {
			if (typeof query !== "string") queries.push(dialect.sqlToQuery(query.getSQL()));
			return all(query);
		});
		try {
			expect(extendMutableForkPrefixTx(tx, "source", rows, rows[0].seq, [], [], 500)).toHaveLength(
				3,
			);
		} finally {
			capture.mockRestore();
		}
	});
	const producerQuery = queries.find((query) => query.sql.includes("FROM background_tasks task"));
	if (!producerQuery) throw new Error("Missing production producer query");
	const plan = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${producerQuery.sql}`)
		.all(...(producerQuery.params as never[]));
	const details = JSON.stringify(plan);
	expect(details).toContain(
		"SEARCH task USING INDEX idx_bg_tasks_parent (parent_narrator_id=? AND status=?)",
	);
	expect(details).toContain(
		"SEARCH c USING INDEX idx_toolcalls_status (narrator_id=? AND status=?)",
	);
	expect(details).toContain("idx_toolcalls_attempt (narrator_id=? AND tool_use_id=?)");
	expect(details).not.toContain("SCAN task");
	expect(producerQuery.params).not.toContain("unrelated");
	expect(queries.some((query) => query.sql.includes("JOIN narrator_messages m"))).toBe(false);
	const child = await narratorService.forkNarrator("source", null, { inheritMode: "full" });
	expect(refsOf(child.id)).toHaveLength(3);
});

async function seedLargeStablePrefix(count: number) {
	await narratorPersistence.persistUserMessage("source", "old stable");
	const marker = await narratorPersistence.persistCompactingMessage("source");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
	const tail = await narratorPersistence.persistUserMessage("source", "tail");
	const sourceRefs = refsOf("source");
	const insertMessage = sqlite.prepare(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, 'source', 'user', '[]', ?)`,
	);
	const insertRef = sqlite.prepare(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'source', ?, ?)`,
	);
	db.transaction(() => {
		for (let index = 0; index < count; index++) {
			const id = `stable-prefix-${index}`;
			insertMessage.run(id, NOW);
			insertRef.run(`ref-${id}`, id, sourceRefs[0].seq);
		}
	});
	return { tail, rows: [{ ...lastRef(sourceRefs), isCompact: 0, segmentCompactId: null }] };
}

test("fresh and connected full forks never scan 12000 stable old ref owners", async () => {
	const { tail, rows } = await seedLargeStablePrefix(12000);
	seedNarrator("connected");
	await db
		.update(narrators)
		.set({ parentNarratorId: "source", inheritMode: "full" })
		.where(eq(narrators.id, "connected"));
	sqlite
		.prepare(`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, segment_compact_id)
		SELECT lower(hex(randomblob(16))), 'connected', message_id, seq, is_compact, segment_compact_id
		FROM narrator_message_refs WHERE narrator_id = 'source'`)
		.run();
	const dialect = new SQLiteSyncDialect();
	for (const holder of ["source", "connected"]) {
		const queries: string[] = [];
		db.transaction((tx) => {
			const all = tx.all.bind(tx);
			const capture = spyOn(tx, "all").mockImplementation((query) => {
				if (typeof query !== "string") queries.push(dialect.sqlToQuery(query.getSQL()).sql);
				return all(query);
			});
			try {
				expect(extendMutableForkPrefixTx(tx, holder, rows, rows[0].seq, [], [], 500)).toBe(rows);
			} finally {
				capture.mockRestore();
			}
		});
		expect(queries.some((query) => query.includes("JOIN narrator_messages m"))).toBe(false);
		const child = await narratorService.forkNarrator(holder, null, { inheritMode: "full" });
		expect(refsOf(child.id)).toEqual([{ messageId: tail.id, seq: rows[0].seq }]);
	}
});

test("a detached owner scan counts actual refs and fails before opening any body", async () => {
	const { rows } = await seedLargeStablePrefix(4096);
	await db.update(narrators).set({ inheritMode: "full" }).where(eq(narrators.id, "source"));
	db.transaction((tx) => {
		const read = spyOn(tx.query.narratorMessages, "findFirst");
		try {
			expect(() => extendMutableForkPrefixTx(tx, "source", rows, rows[0].seq, [], [], 500)).toThrow(
				"producer metadata exceeds its safe scan budget",
			);
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});
	await expect(
		narratorService.forkNarrator("source", null, { inheritMode: "full" }),
	).rejects.toThrow("producer metadata exceeds its safe scan budget");
	expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
});

test("slow detached owner discovery logs but never discards a valid bounded result", async () => {
	await seedSettledBackgroundBeforeCompact();
	await db.update(narrators).set({ inheritMode: "full" }).where(eq(narrators.id, "source"));
	const rows = [{ ...lastRef(refsOf("source")), isCompact: 0, segmentCompactId: null }];
	db.transaction((tx) => {
		let elapsed = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => {
			elapsed += 100;
			return elapsed;
		});
		try {
			expect(extendMutableForkPrefixTx(tx, "source", rows, rows[0].seq, [], [], 500)).toHaveLength(
				3,
			);
		} finally {
			clock.mockRestore();
		}
	});
});

test("129 COW and retained pending tool cards stay shared despite their open native tool blocks", async () => {
	const partial = await openPartial();
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "tool_use",
		id: "historical-tool",
		name: "Bash",
		input: {},
	});
	seedNarrator("historical");
	await db
		.update(narrators)
		.set({ parentNarratorId: "source", inheritMode: "full" })
		.where(eq(narrators.id, "historical"));
	const calls = callsOf(partial.id);
	db.transaction((tx) => {
		const original = readEnvelope(tx, partial.id);
		if (!original) throw new Error("Missing source message");
		for (let index = 0; index < 129; index++) {
			const id = `historical-ref-${index}`;
			tx.insert(narratorMessageRefs)
				.values({ id, narratorId: "historical", messageId: partial.id, seq: index })
				.run();
			const snapshotId = cowEnvelopeTx(tx, {
				original,
				ref: { id, narratorId: "historical" },
				toolCalls: calls,
			});
			if (index % 2)
				sqlite
					.prepare(
						"UPDATE narrator_tool_calls SET execution_origin_tool_call_id = id WHERE message_id = ?",
					)
					.run(snapshotId);
		}
	});
	const historyRefs = refsOf("historical");
	expect(historyRefs).toHaveLength(129);
	expect(
		historyRefs.every((ref) => blocksOf(ref.messageId).some((block) => block.phase === "open")),
	).toBe(true);
	expect(
		historyRefs.every((ref) => callsOf(ref.messageId)[0].executionOriginToolCallId !== null),
	).toBe(true);
	const child = await narratorService.forkNarrator("historical", null, { inheritMode: "full" });
	expect(refsOf(child.id)).toEqual(historyRefs);
	const marker = await narratorPersistence.persistCompactingMessage("historical");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "historical", "summary");
	const tail = await narratorPersistence.persistUserMessage("historical", "tail");
	const lazyChild = await narratorService.forkNarrator("historical", null, { inheritMode: "full" });
	expect(refsOf(lazyChild.id).map((ref) => ref.messageId)).toEqual([tail.id]);
	await ensureAllRefsMaterialized(lazyChild.id);
	expect(refsOf(lazyChild.id).slice(0, 129)).toEqual(historyRefs);
});

for (const producer of [
	"current-partial",
	"open-block",
	"pending-ledger",
	"legacy-paused-task",
] as const) {
	test(`a pre-compact ${producer} extends the continuous window`, async () => {
		const partial = await openPartial();
		let callId: string | undefined;
		if (producer === "current-partial" || producer === "open-block") {
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "text",
				text: "before fork",
				completed: producer === "current-partial",
			});
			if (producer === "current-partial") installLivePartial(partial.id);
		} else {
			callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "tool_use",
				id: "old-tool",
				name: "Bash",
				input: {},
			});
			if (producer === "legacy-paused-task") {
				await narratorPersistence.updateToolCallResult(
					"old-tool",
					{ status: "success", output: "before fork" },
					partial.id,
					callId,
				);
				await db.insert(backgroundTasks).values({
					id: "paused-task",
					parentNarratorId: "source",
					type: "transfer",
					status: "paused",
					toolUseId: "old-tool",
					startedAt: NOW,
					createdAt: NOW,
					updatedAt: NOW,
				});
			} else {
				sqlite
					.prepare("UPDATE narrator_tool_calls SET status = 'pending' WHERE id = ?")
					.run(callId as string);
				sqlite
					.prepare("UPDATE narrator_blocks SET phase = 'done' WHERE message_id = ?")
					.run(partial.id);
			}
		}
		const marker = await narratorPersistence.persistCompactingMessage("source");
		await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
		await narratorPersistence.persistUserMessage("source", "stable tail");
		const child = await narratorService.forkNarrator("source", null, { inheritMode: "full" });
		const snapshotId = refsOf(child.id)[0].messageId;
		expect(snapshotId).not.toBe(partial.id);
		const frozenBody = bodyOf(snapshotId);
		const frozenCalls = callsOf(snapshotId);
		if (callId)
			await narratorPersistence.updateToolCallResult(
				"old-tool",
				{ status: "success", output: "after fork" },
				partial.id,
				callId,
			);
		else
			await narratorPersistence.appendBlockToMessage(partial.id, "source", {
				type: "text",
				text: "after fork",
			});
		await ensureAllRefsMaterialized(child.id);
		expect(bodyOf(snapshotId)).toEqual(frozenBody);
		expect(callsOf(snapshotId)).toEqual(frozenCalls);
		expect(refsOf(child.id)).toHaveLength(3);
	});
}

test("an explicit fork point freezes earlier producers but excludes later active history", async () => {
	const partial = await openPartial();
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "before fork",
		completed: false,
	});
	const marker = await narratorPersistence.persistCompactingMessage("source");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
	const point = await narratorPersistence.persistUserMessage("source", "fork point");
	const later = await openPartial("later");
	await narratorPersistence.appendBlockToMessage(later.id, "source", {
		type: "text",
		text: "x".repeat(4 * 1024 * 1024),
		completed: false,
	});
	const child = await narratorService.forkNarrator("source", null, {
		inheritMode: "full",
		forkMessageId: point.id,
	});
	expect(refsOf(child.id).map((ref) => ref.seq)).toEqual(
		refsOf("source")
			.slice(0, 3)
			.map((ref) => ref.seq),
	);
	expect(refsOf(child.id).at(-1)?.messageId).toBe(point.id);
	expect(child.forkMessageId).toBe(point.id);
	await ensureAllRefsMaterialized(child.id);
	expect(refsOf(child.id).some((ref) => ref.messageId === later.id)).toBe(false);
	expect(JSON.stringify(bodyOf(refsOf(child.id)[0].messageId))).toContain("before fork");
});

test("large stable pre-compact bodies remain lazy and are never opened by the prefix locator", async () => {
	await narratorPersistence.persistUserMessage("source", "s".repeat(5 * 1024 * 1024));
	const marker = await narratorPersistence.persistCompactingMessage("source");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
	const tail = await narratorPersistence.persistUserMessage("source", "tail");
	const rows = [{ ...lastRef(refsOf("source")), isCompact: 0, segmentCompactId: null }];
	db.transaction((tx) => {
		const read = spyOn(tx.query.narratorMessages, "findFirst");
		const ledger = spyOn(tx.query.narratorToolCalls, "findMany");
		try {
			expect(extendMutableForkPrefixTx(tx, "source", rows, rows[0].seq, [], [], 500)).toBe(rows);
			expect(read).not.toHaveBeenCalled();
			expect(ledger).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			ledger.mockRestore();
		}
	});
	const child = await narratorService.forkNarrator("source", null, { inheritMode: "full" });
	expect(refsOf(child.id)).toEqual([{ messageId: tail.id, seq: rows[0].seq }]);
	expect(child.refsBackfillCursor).toBe(rows[0].seq);
});

for (const tieCount of [497, 498]) {
	test(`the expanded interval counts all ${tieCount} same-seq refs before copying`, async () => {
		const partial = await openPartial();
		await narratorPersistence.appendBlockToMessage(partial.id, "source", {
			type: "text",
			text: "live",
			completed: false,
		});
		const marker = await narratorPersistence.persistCompactingMessage("source");
		await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
		await narratorPersistence.persistUserMessage("source", "tail");
		const seq = refsOf("source")[0].seq;
		const insertMessage = sqlite.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, 'source', 'user', '[]', ?)`,
		);
		const insertRef = sqlite.prepare(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'source', ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < tieCount; index++) {
				const id = `tie-${index}`;
				insertMessage.run(id, NOW);
				insertRef.run(`ref-${id}`, id, seq);
			}
		});
		if (tieCount === 498) {
			// Even excluded segment refs consume the bounded metadata scan budget.
			sqlite
				.prepare(
					"UPDATE narrator_message_refs SET segment_compact_id = ? WHERE message_id LIKE 'tie-%'",
				)
				.run(marker.id);
			const rows = [{ ...lastRef(refsOf("source")), isCompact: 0, segmentCompactId: null }];
			db.transaction((tx) => {
				const read = spyOn(tx.query.narratorMessages, "findFirst");
				try {
					expect(() =>
						extendMutableForkPrefixTx(tx, "source", rows, rows[0].seq, [], [], 500),
					).toThrow("safe copy budget");
					expect(read).not.toHaveBeenCalled();
				} finally {
					read.mockRestore();
				}
			});
			await expect(
				narratorService.forkNarrator("source", null, { inheritMode: "full" }),
			).rejects.toThrow("safe copy budget");
			expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
		} else {
			const child = await narratorService.forkNarrator("source", null, { inheritMode: "full" });
			expect(refsOf(child.id)).toHaveLength(500);
			expect(refsOf(child.id).filter((ref) => ref.seq === seq)).toHaveLength(498);
			await ensureAllRefsMaterialized(child.id);
			expect(refsOf(child.id)).toHaveLength(500);
		}
	});
}

test("an oversized mutable old prefix still fails the snapshot byte preflight", async () => {
	const partial = await openPartial();
	await narratorPersistence.appendBlockToMessage(partial.id, "source", {
		type: "text",
		text: "x".repeat(4 * 1024 * 1024),
		completed: false,
	});
	const marker = await narratorPersistence.persistCompactingMessage("source");
	await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
	await narratorPersistence.persistUserMessage("source", "tail");
	await expect(
		narratorService.forkNarrator("source", null, { inheritMode: "full" }),
	).rejects.toThrow("safe copy budget");
	expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
});

function expectBudgetRejectionBeforeBodies() {
	db.transaction((tx) => {
		const read = spyOn(tx.query.narratorMessages, "findFirst");
		const ledger = spyOn(tx.query.narratorToolCalls, "findMany");
		try {
			expect(() => snapshotMutableForkMessagesTx(tx, "source")).toThrow("safe copy budget");
			expect(read).not.toHaveBeenCalled();
			expect(ledger).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			ledger.mockRestore();
		}
	});
}

describe("fork snapshot copy budgets", () => {
	test("large stable history is shared without entering the mutable body budget", async () => {
		const stable = await narratorPersistence.persistUserMessage(
			"source",
			"s".repeat(5 * 1024 * 1024),
		);
		const partial = await openPartial();
		await narratorPersistence.appendBlockToMessage(partial.id, "source", {
			type: "text",
			text: "small mutable tail",
			completed: false,
		});
		const child = await fork("full", [stable.id, partial.id]);
		expect(refsOf(child.id)[0].messageId).toBe(stable.id);
		expect(refsOf(child.id)[1].messageId).not.toBe(partial.id);
	});

	test("oversized mutable envelope aborts the entire fork transaction", async () => {
		const partial = await openPartial();
		await narratorPersistence.appendBlockToMessage(partial.id, "source", {
			type: "text",
			text: "x".repeat(4 * 1024 * 1024),
			completed: false,
		});
		const sourceRefs = refsOf("source");
		expectBudgetRejectionBeforeBodies();
		await expect(fork("full", [partial.id])).rejects.toThrow("safe copy budget");
		expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
		expect(refsOf("source")).toEqual(sourceRefs);
	});

	test("ledger payload sizes are checked before copying bodies", async () => {
		const partial = await openPartial();
		const callId = await narratorPersistence.appendBlockToMessage(partial.id, "source", {
			type: "tool_use",
			id: "huge-ledger",
			name: "Bash",
			input: {},
		});
		if (!callId) throw new Error("Expected a persisted tool call");
		sqlite
			.prepare("UPDATE narrator_tool_calls SET output_json = ? WHERE id = ?")
			.run(JSON.stringify("x".repeat(4 * 1024 * 1024)), callId as string);
		expectBudgetRejectionBeforeBodies();
		await expect(fork("selected", [partial.id])).rejects.toThrow("safe copy budget");
		expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
		expect(callsOf(partial.id)[0].id).toBe(callId);
	});

	test("too many mutable envelopes are rejected before any body read", () => {
		const insertMessage = sqlite.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES (?, 'source', 'assistant', '[]', ?)`,
		);
		const insertRef = sqlite.prepare(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES (?, 'source', ?, ?)`,
		);
		const insertBlock = sqlite.prepare(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, phase, created_at, payload)
			 VALUES (?, ?, 0, 'output', 'open', ?, '{}')`,
		);
		db.transaction(() => {
			for (let index = 0; index < 129; index++) {
				const id = `mutable-${index}`;
				insertMessage.run(id, NOW);
				insertRef.run(`ref-${index}`, id, index);
				insertBlock.run(`block-${index}`, id, NOW);
			}
		});
		expectBudgetRejectionBeforeBodies();
	});

	test("129 canonical pending tool cards still exceed the live message budget before and after compact", async () => {
		const insertMessage = sqlite.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, 'source', 'assistant', '[]', ?)`,
		);
		const insertRef = sqlite.prepare(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'source', ?, ?)`,
		);
		const insertBlock = sqlite.prepare(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, subtype, phase, created_at, payload, wire_id) VALUES (?, ?, 0, 'tool', 'Bash', 'open', ?, '{}', ?)`,
		);
		const insertCall = sqlite.prepare(
			`INSERT INTO narrator_tool_calls (id, message_id, tool_use_id, narrator_id, tool_name, status, block_id, created_at) VALUES (?, ?, ?, 'source', 'Bash', 'pending', ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 129; index++) {
				const id = `canonical-${index}`;
				insertMessage.run(id, NOW);
				insertRef.run(`ref-${id}`, id, index);
				insertBlock.run(`block-${id}`, id, NOW, `tool-${id}`);
				insertCall.run(`call-${id}`, id, `tool-${id}`, `block-${id}`, NOW);
			}
		});
		expectBudgetRejectionBeforeBodies();
		await expect(
			narratorService.forkNarrator("source", null, { inheritMode: "full" }),
		).rejects.toThrow("safe copy budget");
		const marker = await narratorPersistence.persistCompactingMessage("source");
		await narratorPersistence.finalizeCompactingMessage(marker.id, "source", "summary");
		await narratorPersistence.persistUserMessage("source", "tail");
		await expect(
			narratorService.forkNarrator("source", null, { inheritMode: "full" }),
		).rejects.toThrow("safe copy budget");
		expect(db.select({ id: narrators.id }).from(narrators).all()).toEqual([{ id: "source" }]);
	});

	for (const kind of ["blocks", "calls"] as const) {
		test(`too many ${kind} are rejected before any body or ledger read`, async () => {
			const partial = await openPartial();
			const insert =
				kind === "blocks"
					? sqlite.prepare(
							`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, phase, created_at, payload)
							 VALUES (?, ?, ?, 'output', 'open', ?, '{}')`,
						)
					: sqlite.prepare(
							`INSERT INTO narrator_tool_calls
							 (id, message_id, tool_use_id, narrator_id, tool_name, status, created_at)
							 VALUES (?, ?, ?, 'source', 'Bash', 'pending', ?)`,
						);
			db.transaction(() => {
				for (let index = 0; index < 2049; index++)
					insert.run(`row-${index}`, partial.id, index, NOW);
			});
			expectBudgetRejectionBeforeBodies();
		});
	}
});
