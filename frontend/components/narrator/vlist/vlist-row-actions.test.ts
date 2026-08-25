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

	it("produces onEditMessage bound to the message id when editable", () => {
		const calls: string[] = [];
		const actions = buildRowCtxActions(
			{ messageId: MSG, blockIndex: 0 },
			{ onEditMessage: (id) => calls.push(`edit:${id}`) },
		);
		actions.onEditMessage?.();
		expect(calls).toEqual([`edit:${MSG}`]);
	});

	it("hides onEditMessage when the row is not editable", () => {
		const actions = buildRowCtxActions(
			{ messageId: MSG, blockIndex: 0, editable: false },
			{ onEditMessage: () => {} },
		);
		expect(actions.onEditMessage).toBeUndefined();
	});

	it("hides onEditMessage when no handler is supplied", () => {
		expect(
			buildRowCtxActions({ messageId: MSG, blockIndex: 0, editable: true }, {}).onEditMessage,
		).toBeUndefined();
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

	it("binds view-session to a Send's single addressee", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ toolName: "Send", sendTargetNarratorId: "sub-3" },
			allHandlers(sink),
		);
		actions.onViewSubagentSession?.();
		expect(sink).toEqual(["view:sub-3"]);
	});

	/**
	 * ⚠️ A Send target is not this row's child — it may be a sibling, or the
	 * parent — and its background lifecycle belongs to the Agent call that created
	 * it. Detaching or cancelling from a Send row would act on a narrator this row
	 * never owned, so the id must reach view-session ONLY.
	 */
	it("never offers detach or cancel from a Send row", () => {
		const running = buildRowToolActions(
			{ toolName: "Send", sendTargetNarratorId: "sub-3" },
			allHandlers([]),
		);
		expect(running.onViewSubagentSession).toBeDefined();
		expect(running.onDetachSubagent).toBeUndefined();
		expect(running.onCancelBackgroundTask).toBeUndefined();

		const background = buildRowToolActions(
			{ toolName: "Send", sendTargetNarratorId: "sub-3", isBackground: true },
			allHandlers([]),
		);
		expect(background.onDetachSubagent).toBeUndefined();
		expect(background.onCancelBackgroundTask).toBeUndefined();
	});

	/**
	 * A real child (Agent/Task) still wins: when both facts are present the row IS
	 * a subagent card, and its own child is what "view session" should open.
	 */
	it("prefers a real child narrator over a Send target", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ toolName: "Send", subagentNarratorId: "sub-child", sendTargetNarratorId: "sub-target" },
			allHandlers(sink),
		);
		actions.onViewSubagentSession?.();
		expect(sink).toEqual(["view:sub-child"]);
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

	// ── file panel gating ──────────────────────────────────────────────────────

	it("binds open-in-panel to the tool's file path", () => {
		const sink: string[] = [];
		const actions = buildRowToolActions(
			{ toolName: "Read", filePath: "/repo/a.json", isFileTool: true, isReadTool: true },
			{ onOpenFilePanel: (path) => sink.push(`open:${path}`) },
		);
		actions.onOpenFilePanel?.();
		expect(sink).toEqual(["open:/repo/a.json"]);
	});

	// Broader than the inline preview on purpose: the panel shows the file's
	// current on-disk content, which is just as meaningful after a write.
	it("offers open-in-panel for Write / Edit, not just Read", () => {
		for (const toolName of ["Write", "Edit"]) {
			const actions = buildRowToolActions(
				{ toolName, filePath: "/repo/a.ts", isFileTool: true },
				{ onOpenFilePanel: () => {} },
			);
			expect(actions.onOpenFilePanel).toBeDefined();
		}
	});

	it("hides open-in-panel without a path, without isFileTool, or without the handler", () => {
		expect(
			buildRowToolActions({ toolName: "Read", isFileTool: true }, { onOpenFilePanel: () => {} })
				.onOpenFilePanel,
		).toBeUndefined();
		expect(
			buildRowToolActions({ toolName: "Bash", filePath: "/x" }, { onOpenFilePanel: () => {} })
				.onOpenFilePanel,
		).toBeUndefined();
		expect(
			buildRowToolActions({ toolName: "Read", filePath: "/x", isFileTool: true }, {})
				.onOpenFilePanel,
		).toBeUndefined();
	});

	it("hides detach/cancel when only their handlers are missing", () => {
		const actions = buildRowToolActions({ subagentNarratorId: "sub-1" }, {});
		expect(actions.onDetachSubagent).toBeUndefined();
		expect(actions.onCancelBackgroundTask).toBeUndefined();
	});
});
