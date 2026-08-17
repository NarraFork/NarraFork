import { describe, expect, test } from "bun:test";
import type { ChunkManifestEntry, TreeMessage } from "../../lib/api";
import {
	applyChunkUpdaters,
	chunkRangeVersionMatchesManifest,
	getStructuralReconcileRetryDelay,
} from "./useNarratorChunks";
import {
	applyCompactProgressByMessageId,
	applySubagentActivitySnapshots,
	applySubagentToolActivity,
	type ChunkMutState,
	type ChunkUpdater,
	getCatchUpStructuralMode,
	isStructuralInsert,
	shouldIgnoreParentChildMessage,
	willDropTopLevelMessage,
} from "./useNarratorChunksWS";

function displayMessage(type: string, extra: Record<string, unknown> = {}) {
	return {
		id: `message-${type}`,
		narratorId: "n1",
		role: "disp" as const,
		parentToolUseId: null,
		contentJson: [{ type, ...extra }],
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-07-17T00:00:00.000Z",
	};
}

function parentAgentMessage(): TreeMessage {
	return {
		id: "parent-message",
		narratorId: "n1",
		role: "assistant" as const,
		parentToolUseId: null,
		contentJson: [{ type: "tool_use", id: "parent-tool", name: "Agent" }],
		contentText: null,
		toolCalls: [{ toolUseId: "parent-tool", toolName: "Agent" }],
		children: [],
		createdAt: "2026-07-17T00:00:00.000Z",
	};
}

describe("subagent activity chunk reducers", () => {
	test("parent pages ignore child message bodies while subagent pages keep them top-level", () => {
		expect(shouldIgnoreParentChildMessage("parent-tool", false)).toBe(true);
		expect(shouldIgnoreParentChildMessage("parent-tool", true)).toBe(false);
		expect(shouldIgnoreParentChildMessage(null, false)).toBe(false);
	});

	test("updates parent activity without inserting synthetic child messages", () => {
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [parentAgentMessage()]]]),
			manifest: [],
			total: 1,
		};
		const next = applySubagentToolActivity(state, "parent-tool", {
			toolCallId: "call-1",
			toolUseId: "child-tool",
			toolName: "Read",
			status: "running",
			createdAt: 1,
			timing: null,
		});
		const message = next.loaded.get("chunk-1")?.[0];
		expect(message?.children).toEqual([]);
		expect(message?.contentJson[0]._subagentActivity?.latestToolCalls[0]).toMatchObject({
			toolUseId: "child-tool",
			status: "running",
		});
	});

	test("streaming activity does not overwrite a known model with an empty value", () => {
		const parent = parentAgentMessage();
		const knownActivity = {
			subagentNarratorId: "sub-1",
			model: "known-model",
			latestToolCalls: [],
		};
		parent.contentJson[0]._subagentActivity = knownActivity;
		parent.toolCalls[0]._subagentActivity = knownActivity;
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [parent]]]),
			manifest: [],
			total: 1,
		};

		const next = applySubagentToolActivity(
			state,
			"parent-tool",
			{
				toolCallId: "call-1",
				toolUseId: "child-tool",
				toolName: "Read",
				status: "streaming",
				createdAt: 1,
				timing: null,
			},
			{ subagentNarratorId: "sub-1", model: "" },
		);

		expect(next.loaded.get("chunk-1")?.[0].contentJson[0]._subagentActivity?.model).toBe(
			"known-model",
		);
	});

	test("catch-up replaces parent activity snapshots instead of applying orphan children", () => {
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [parentAgentMessage()]]]),
			manifest: [],
			total: 1,
		};
		const next = applySubagentActivitySnapshots(state, [
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: "sub-1",
					model: "model-1",
					reasoningEffort: "high",
					latestToolCalls: [
						{
							toolCallId: "call-2",
							toolUseId: "child-tool-2",
							toolName: "Bash",
							status: "success",
							createdAt: 2,
							timing: { completedAt: 3 },
						},
					],
				},
			},
		]);
		const activity = next.loaded.get("chunk-1")?.[0].contentJson[0]._subagentActivity;
		expect(activity?.subagentNarratorId).toBe("sub-1");
		expect(activity?.reasoningEffort).toBe("high");
		expect(activity?.latestToolCalls.map((header) => header.toolUseId)).toEqual(["child-tool-2"]);
	});
});

describe("narrator chunk structural messages", () => {
	test("keeps existing compact and ask-in-passing markers structural", () => {
		expect(isStructuralInsert(displayMessage("compact"))).toBe(true);
		expect(isStructuralInsert(displayMessage("segment_compact"))).toBe(true);
		expect(isStructuralInsert(displayMessage("ask_in_passing"))).toBe(true);
	});

	test("does not classify ordinary display notices as structural inserts", () => {
		expect(isStructuralInsert(displayMessage("info"))).toBe(false);
	});

	test("computes structural mode before queued updates are flushed", () => {
		const loaded = new Map<string, ReturnType<typeof displayMessage>[]>([
			["chunk-1", [displayMessage("info")]],
		]);
		expect(getCatchUpStructuralMode([displayMessage("info")], loaded)).toBeUndefined();
		expect(getCatchUpStructuralMode([displayMessage("compact")], loaded)).toBe("full");
	});

	test("uses diff for an already-loaded structural marker and full for a missing one", () => {
		const loadedMessage = displayMessage("compact");
		const loaded = new Map<string, ReturnType<typeof displayMessage>[]>([
			["chunk-1", [loadedMessage]],
		]);
		const updated = {
			...loadedMessage,
			contentJson: [{ type: "compact", status: "compacted" }],
		};
		expect(getCatchUpStructuralMode([updated], loaded)).toBe("diff");
		expect(getCatchUpStructuralMode([displayMessage("segment_compact")], loaded)).toBe("full");
	});

	test("updates only the matching live compact marker", () => {
		const compact = {
			...displayMessage("compact", { status: "compacting", outputChars: 0 }),
			id: "compact-target",
		};
		const other = {
			...displayMessage("compact", { status: "compacting", outputChars: 0 }),
			id: "compact-other",
		};
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [compact, other]]]),
			manifest: [],
			total: 2,
		};

		const next = applyCompactProgressByMessageId(
			state,
			"compact-target",
			{ phase: "output", thinkingChars: 0, outputChars: 321 },
			false,
		);
		expect(next.loaded.get("chunk-1")?.[0].contentJson[0].outputChars).toBe(321);
		expect(next.loaded.get("chunk-1")?.[1].contentJson[0].outputChars).toBe(0);
	});

	test("switches the marker to the thinking phase before any output exists", () => {
		// The thinking phase keeps outputChars at 0, so a de-duplication key that only
		// watched that field would drop every thinking tick.
		const compact = {
			...displayMessage("compact", { status: "compacting", outputChars: 0 }),
			id: "compact-target",
		};
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [compact]]]),
			manifest: [],
			total: 1,
		};

		const next = applyCompactProgressByMessageId(
			state,
			"compact-target",
			{ phase: "thinking", thinkingChars: 140, outputChars: 0 },
			false,
		);
		expect(next).not.toBe(state);
		expect(next.loaded.get("chunk-1")?.[0].contentJson[0]).toMatchObject({
			progressPhase: "thinking",
			thinkingChars: 140,
			outputChars: 0,
		});
	});

	test("does not apply segment progress to a regular compact marker", () => {
		const compact = {
			...displayMessage("compact", { status: "compacting", outputChars: 0 }),
			id: "compact-target",
		};
		const state: ChunkMutState = {
			loaded: new Map([["chunk-1", [compact]]]),
			manifest: [],
			total: 1,
		};

		expect(
			applyCompactProgressByMessageId(
				state,
				"compact-target",
				{ phase: "output", thinkingChars: 0, outputChars: 99 },
				true,
			),
		).toBe(state);
	});
});

function createFakeTimers() {
	type Task = { id: number; at: number; callback: () => void };
	let now = 0;
	let nextId = 1;
	const tasks: Task[] = [];
	return {
		setTimeout(callback: () => void, delay: number) {
			const id = nextId++;
			tasks.push({ id, at: now + delay, callback });
			return id;
		},
		tick(milliseconds: number) {
			const end = now + milliseconds;
			while (true) {
				let nextIndex = -1;
				for (let i = 0; i < tasks.length; i++) {
					if (tasks[i].at > end) continue;
					if (nextIndex < 0 || tasks[i].at < tasks[nextIndex].at) nextIndex = i;
				}
				if (nextIndex < 0) break;
				const [task] = tasks.splice(nextIndex, 1);
				now = task.at;
				task.callback();
			}
			now = end;
		},
		pending() {
			return tasks.length;
		},
	};
}

describe("structural reconcile invariants", () => {
	test("replays both an unflushed and an already-flushed updater", () => {
		const base: ChunkMutState = { loaded: new Map(), manifest: [], total: 0 };
		const updater: ChunkUpdater = (state) => ({ ...state, total: state.total + 1 });

		const unflushedSnapshot = applyChunkUpdaters(base, [updater]);
		const flushedBeforeSnapshot = applyChunkUpdaters(base, [updater]);
		const replayedOnNewSnapshot = applyChunkUpdaters(
			{ loaded: new Map(), manifest: [], total: 10 },
			[updater],
		);

		expect(unflushedSnapshot.total).toBe(1);
		expect(flushedBeforeSnapshot.total).toBe(1);
		expect(replayedOnNewSnapshot.total).toBe(11);
	});

	test("rejects a range whose messageVersion differs from the manifest", () => {
		expect(chunkRangeVersionMatchesManifest(12, 12)).toBe(true);
		expect(chunkRangeVersionMatchesManifest(12, 13)).toBe(false);
	});

	test("bounds reconcile retries with deterministic fake timers", () => {
		const timers = createFakeTimers();
		let attempts = 0;
		const retry = () => {
			attempts += 1;
			const delay = getStructuralReconcileRetryDelay(attempts);
			if (delay != null) timers.setTimeout(retry, delay);
		};

		retry();
		expect(attempts).toBe(1);
		timers.tick(99);
		expect(attempts).toBe(1);
		timers.tick(1);
		expect(attempts).toBe(2);
		timers.tick(200);
		expect(attempts).toBe(3);
		timers.tick(400);
		expect(attempts).toBe(4);
		timers.tick(10_000);
		expect(attempts).toBe(4);
		expect(timers.pending()).toBe(0);
	});
});

describe("willDropTopLevelMessage", () => {
	const manifest: ChunkManifestEntry[] = [
		{ id: "chunk-1", firstSeq: 1, lastSeq: 20, count: 20 },
		{ id: "chunk-2", firstSeq: 21, lastSeq: 40, count: 20 },
	];
	const loadedWith = (...chunkIds: string[]) =>
		new Map<string, TreeMessage[]>(chunkIds.map((id) => [id, []]));

	test("empty manifest never drops: 3a seeds a fresh first chunk", () => {
		expect(willDropTopLevelMessage({ seq: 5 }, new Map(), [])).toBe(false);
		expect(willDropTopLevelMessage({}, new Map(), [])).toBe(false);
	});

	test("tail resident: every append branch lands", () => {
		const loaded = loadedWith("chunk-2");
		expect(willDropTopLevelMessage({ seq: 41 }, loaded, manifest)).toBe(false);
		expect(willDropTopLevelMessage({ seq: 30 }, loaded, manifest)).toBe(false);
		expect(willDropTopLevelMessage({}, loaded, manifest)).toBe(false);
	});

	test("tail not loaded: a seq beyond the tail drops (3b)", () => {
		expect(willDropTopLevelMessage({ seq: 41 }, loadedWith("chunk-1"), manifest)).toBe(true);
		expect(willDropTopLevelMessage({ seq: 41 }, new Map(), manifest)).toBe(true);
	});

	test("tail not loaded: a missing seq drops (3d tail fallback)", () => {
		expect(willDropTopLevelMessage({}, loadedWith("chunk-1"), manifest)).toBe(true);
		expect(willDropTopLevelMessage({ seq: Number.NaN }, loadedWith("chunk-1"), manifest)).toBe(
			true,
		);
	});

	test("tail not loaded: a mid-manifest seq is backfilled by ensureLoaded (3c)", () => {
		expect(willDropTopLevelMessage({ seq: 10 }, new Map(), manifest)).toBe(false);
		// seq == tail.lastSeq falls inside the tail chunk's range, not the 3b append path.
		expect(willDropTopLevelMessage({ seq: 40 }, new Map(), manifest)).toBe(false);
	});
});
