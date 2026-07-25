/** vlist-row-actions.test.ts — unit tests for the per-row action builders. */

import { describe, expect, it } from "bun:test";
import {
	buildRowCtxActions,
	buildRowToolActions,
	deleteBlockIndices,
	type VListRowHandlers,
} from "./vlist-row-actions";
import type { VListToolMeta } from "./vlist-tool-meta";

const MSG = "msg-1";

describe("buildRowCtxActions", () => {
	it("always carries the message id", () => {
		expect(buildRowCtxActions({ messageId: MSG, blockIndex: 0 }, {}).messageId).toBe(MSG);
	});

	it("omits every action when no handler is supplied", () => {
		const actions = buildRowCtxActions({ messageId: MSG, blockIndex: 2 }, {});
		expect(actions.onForkFromMessage).toBeUndefined();
		expect(actions.onDeleteBlock).toBeUndefined();
		expect(actions.onRollbackToBlock).toBeUndefined();
	});

	it("binds the message id into the message-level handlers", () => {
		const seen: string[] = [];
		const actions = buildRowCtxActions(
			{ messageId: MSG, blockIndex: 1 },
			{
				onForkFromMessage: (id) => seen.push(`fork:${id}`),
				onCompactBeforeMessage: (id) => seen.push(`compact:${id}`),
				onClearContextBefore: (id) => seen.push(`clear:${id}`),
				onManualSummarize: (id) => seen.push(`summarize:${id}`),
			},
		);
		actions.onForkFromMessage?.();
		actions.onCompactBeforeMessage?.();
		actions.onClearContextBefore?.();
		actions.onManualSummarize?.();
		expect(seen).toEqual([`fork:${MSG}`, `compact:${MSG}`, `clear:${MSG}`, `summarize:${MSG}`]);
	});

	it("passes a null messageUuid to askInPassing (vlist has no uuid on the row)", () => {
		const calls: Array<[string | null, string]> = [];
		const actions = buildRowCtxActions(
			{ messageId: MSG, blockIndex: 0 },
			{ onAskInPassing: (uuid, id) => calls.push([uuid, id]) },
		);
		actions.onAskInPassing?.();
		expect(calls).toEqual([[null, MSG]]);
	});

	it("forwards the caller-provided block index to delete/rollback", () => {
		const calls: string[] = [];
		const actions = buildRowCtxActions(
			{ messageId: MSG, blockIndex: 4 },
			{
				onDeleteBlock: (id, bi) => calls.push(`del:${id}:${bi}`),
				onRollbackToBlock: (id, bi) => calls.push(`rb:${id}:${bi}`),
			},
		);
		actions.onDeleteBlock?.(7);
		actions.onRollbackToBlock?.(4);
		expect(calls).toEqual([`del:${MSG}:7`, `rb:${MSG}:4`]);
	});
});

describe("deleteBlockIndices", () => {
	it("returns all indices of a reasoning run", () => {
		expect(deleteBlockIndices({ messageId: MSG, blockIndex: 2, blockIndices: [2, 3, 4] })).toEqual([
			2, 3, 4,
		]);
	});

	it("falls back to the primary index", () => {
		expect(deleteBlockIndices({ messageId: MSG, blockIndex: 5 })).toEqual([5]);
		expect(deleteBlockIndices({ messageId: MSG, blockIndex: 5, blockIndices: [] })).toEqual([5]);
	});
});

describe("buildRowToolActions", () => {
	const allHandlers = (sink: string[]): VListRowHandlers => ({
		onViewSubagentSession: (id) => sink.push(`view:${id}`),
		onDetachSubagent: (id) => sink.push(`detach:${id}`),
		onCancelBackgroundTask: (id) => sink.push(`cancel:${id}`),
	});

	it("returns nothing without tool metadata", () => {
		expect(buildRowToolActions(undefined, allHandlers([]))).toEqual({});
	});

	it("returns nothing when the tool has no child narrator", () => {
		const meta: VListToolMeta = { toolName: "Read", filePath: "/a" };
		expect(buildRowToolActions(meta, allHandlers([]))).toEqual({});
	});

	it("binds view-session to the subagent narrator id", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ toolName: "Agent", subagentNarratorId: "sub-1" },
			allHandlers(sink),
		);
		actions.onViewSubagentSession?.();
		expect(sink).toEqual(["view:sub-1"]);
	});

	it("binds view-session to a resolved Await-agent narrator id", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ toolName: "Await", awaitAgentTargetId: "t-1", awaitAgentNarratorId: "sub-2" },
			allHandlers(sink),
		);
		actions.onViewSubagentSession?.();
		expect(sink).toEqual(["view:sub-2"]);
	});

	it("hides view-session for an unresolved Await-agent target", () => {
		const actions = buildRowToolActions(
			{ toolName: "Await", awaitAgentTargetId: "t-1" },
			allHandlers([]),
		);
		expect(actions.onViewSubagentSession).toBeUndefined();
	});

	it("hides view-session when the panel handler is absent", () => {
		const actions = buildRowToolActions({ subagentNarratorId: "sub-1" }, {});
		expect(actions.onViewSubagentSession).toBeUndefined();
	});

	// ── background lifecycle gating ────────────────────────────────────────────

	it("offers detach for a live foreground subagent", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions({ subagentNarratorId: "sub-1" }, allHandlers(sink));
		expect(actions.onCancelBackgroundTask).toBeUndefined();
		actions.onDetachSubagent?.();
		expect(sink).toEqual(["detach:sub-1"]);
	});

	it("offers cancel (not detach) for a live background subagent", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ subagentNarratorId: "sub-1", isBackground: true },
			allHandlers(sink),
		);
		expect(actions.onDetachSubagent).toBeUndefined();
		actions.onCancelBackgroundTask?.();
		expect(sink).toEqual(["cancel:sub-1"]);
	});

	it("offers neither detach nor cancel once the subagent is terminal", () => {
		const foreground = buildRowToolActions(
			{ subagentNarratorId: "sub-1", isTerminal: true },
			allHandlers([]),
		);
		expect(foreground.onDetachSubagent).toBeUndefined();
		expect(foreground.onCancelBackgroundTask).toBeUndefined();

		const background = buildRowToolActions(
			{ subagentNarratorId: "sub-1", isBackground: true, isTerminal: true },
			allHandlers([]),
		);
		expect(background.onCancelBackgroundTask).toBeUndefined();
	});

	it("still offers view-session for a terminal subagent", () => {
		const actions = buildRowToolActions(
			{ subagentNarratorId: "sub-1", isTerminal: true },
			allHandlers([]),
		);
		expect(actions.onViewSubagentSession).toBeDefined();
	});

	it("hides detach/cancel when only their handlers are missing", () => {
		const actions = buildRowToolActions({ subagentNarratorId: "sub-1" }, {});
		expect(actions.onDetachSubagent).toBeUndefined();
		expect(actions.onCancelBackgroundTask).toBeUndefined();
	});
});
