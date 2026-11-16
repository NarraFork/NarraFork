import { describe, expect, test } from "bun:test";
import type {
	OutlineRestoreEntry,
	OutlineRestorePreviewResponse,
	OutlineRestoreResponse,
} from "@shared/outline-restore-api";
import { ApiError } from "../../../lib/api";
import {
	diffEntriesOf,
	diffMarksOf,
	groupPreview,
	historyProblemOf,
	mergePreviewPages,
	needsNewPreview,
	previewGroupOf,
	type RestoreIO,
	RestoreRun,
} from "./history-model";

function entry(
	blockId: string,
	action: OutlineRestoreEntry["action"],
	extra: Partial<OutlineRestoreEntry> = {},
): OutlineRestoreEntry {
	const kind =
		action === "delete" || action === "delete-unless-holds"
			? "added"
			: action === "restore"
				? "removed"
				: action === "move-out"
					? "moved-in"
					: action === "none"
						? "moved-away"
						: "changed";
	return {
		blockId,
		sid: `s-${blockId}`,
		kind,
		fields: [],
		before: null,
		after: null,
		action,
		...extra,
	};
}

function previewPage(
	entries: OutlineRestoreEntry[],
	nextCursor: string | null,
	extra: Partial<OutlineRestorePreviewResponse> = {},
): OutlineRestorePreviewResponse {
	return {
		spaceId: "s",
		rootId: "r",
		thenSeq: 5,
		nowSeq: 9,
		token: "tok",
		restoreId: "rid",
		entries,
		skipped: [],
		nextCursor,
		...extra,
	};
}

function answer(extra: Partial<OutlineRestoreResponse>): OutlineRestoreResponse {
	return {
		spaceId: "s",
		restoreId: "rid",
		done: false,
		cursor: null,
		commits: [],
		changed: 0,
		skipped: [],
		skippedTruncated: false,
		movedAway: 0,
		...extra,
	};
}

const apiError = (status: number, code: string, details?: Record<string, unknown>) =>
	new ApiError("x", status, { error: "x", code, ...(details ? { details } : {}) });

/** An io that answers from scripted queues and records every call. */
function scripted() {
	const calls: Array<{ kind: string; body: unknown }> = [];
	const previews: Array<() => Promise<OutlineRestorePreviewResponse>> = [];
	const restores: Array<() => Promise<OutlineRestoreResponse>> = [];
	const moves: Array<() => Promise<{ commit: { id: string; seq: number } | null }>> = [];
	const io: RestoreIO = {
		preview: (body) => {
			calls.push({ kind: "preview", body });
			const next = previews.shift();
			if (!next) throw new Error("no preview scripted");
			return next();
		},
		restore: (body) => {
			calls.push({ kind: "restore", body });
			const next = restores.shift();
			if (!next) throw new Error("no restore scripted");
			return next();
		},
		moveBack: async (blockId, thenSeq) => {
			calls.push({ kind: "move-back", body: { blockId, thenSeq } });
			const next = moves.shift();
			if (!next) throw new Error("no move scripted");
			const { commit } = await next();
			return { spaceId: "s", blockId, commit, restored: false, orderKeyMoved: false };
		},
	};
	return { io, calls, previews, restores, moves };
}

const now = () => Promise.resolve();

describe("what a failed call of history means", () => {
	test("each code, and the plain statuses", () => {
		expect(
			historyProblemOf(apiError(409, "OUTLINE_RESTORE_CONFLICT", { conflictSeq: 12 })),
		).toEqual({ kind: "conflict", conflictSeq: 12 });
		expect(
			historyProblemOf(apiError(400, "OUTLINE_RESTORE_TOKEN_INVALID", { reason: "expired" })),
		).toEqual({ kind: "expired" });
		expect(
			historyProblemOf(apiError(400, "OUTLINE_RESTORE_TOKEN_INVALID", { reason: "person" })),
		).toEqual({ kind: "person" });
		expect(historyProblemOf(apiError(400, "OUTLINE_RESTORE_TOKEN_INVALID"))).toEqual({
			kind: "token",
		});
		expect(historyProblemOf(apiError(409, "OUTLINE_HISTORY_NOT_READY"))).toEqual({
			kind: "not-ready",
		});
		expect(
			historyProblemOf(apiError(409, "OUTLINE_HISTORY_BEFORE_FLOOR", { floorSeq: 40 })),
		).toEqual({ kind: "before-floor", floorSeq: 40 });
		expect(historyProblemOf(apiError(409, "OUTLINE_RESTORE_ROOT_NOT_THERE"))).toEqual({
			kind: "root",
		});
		expect(historyProblemOf(apiError(409, "OUTLINE_RESTORE_PARENT_GONE"))).toEqual({
			kind: "parent-gone",
		});
		expect(historyProblemOf(new ApiError("x", 403, {}))).toEqual({ kind: "forbidden" });
		expect(historyProblemOf(new ApiError("x", 404, {}))).toEqual({ kind: "missing" });
		expect(historyProblemOf(new Error("boom")).kind).toBe("other");
		expect(needsNewPreview({ kind: "conflict", conflictSeq: null })).toBe(true);
		expect(needsNewPreview({ kind: "not-ready" })).toBe(false);
	});
});

describe("the change list", () => {
	test("groups by what happens; a put-back that stays put is still a put-back", () => {
		expect(previewGroupOf(entry("a", "delete"))).toBe("delete");
		expect(previewGroupOf(entry("a", "delete-unless-holds"))).toBe("delete");
		expect(previewGroupOf(entry("a", "delete", { skip: "holds-kept" }))).toBe("kept");
		expect(previewGroupOf(entry("a", "move-out", { skip: "parent-gone" }))).toBe("kept");
		expect(previewGroupOf(entry("a", "put-back", { skip: "parent-moved-away" }))).toBe("put-back");
		expect(previewGroupOf(entry("a", "none", { deletedSince: true }))).toBe("moved-away");
		const groups = groupPreview([
			entry("m", "none"),
			entry("p", "put-back"),
			entry("d", "delete"),
			entry("r", "restore"),
			entry("k", "delete", { skip: "holds-kept" }),
			entry("o", "move-out", { carries: 3 }),
		]);
		expect(groups.map((g) => g.group)).toEqual([
			"delete",
			"restore",
			"move-out",
			"put-back",
			"kept",
			"moved-away",
		]);
	});

	test("a later page's skip lands on the entry an earlier page listed", () => {
		const merged = mergePreviewPages([
			previewPage([entry("a", "delete"), entry("b", "put-back")], "c1"),
			previewPage([entry("c", "delete")], null, {
				skipped: [
					{ blockId: "a", sid: "s-a", reason: "holds-kept" },
					{ blockId: "z", sid: "s-z", reason: "lock-kept" },
				],
			}),
		]);
		expect(merged.entries.map((e) => [e.blockId, e.skip ?? null])).toEqual([
			["a", "holds-kept"],
			["b", null],
			["c", null],
		]);
		expect(merged.skippedElsewhere.map((s) => s.blockId)).toEqual(["z"]);
	});

	test("a comparison marks in the forest as of then only what was there then", () => {
		const pages = [
			{
				entries: [
					entry("a", "delete"),
					entry("r", "restore"),
					entry("m", "none"),
					entry("c", "put-back"),
					entry("i", "move-out"),
				],
			},
			{ entries: [entry("c", "put-back")] },
		];
		expect([...diffMarksOf(pages)]).toEqual([
			["r", "removed"],
			["m", "moved-away"],
			["c", "changed"],
		]);
		expect(diffEntriesOf(pages).map((e) => e.blockId)).toEqual(["a", "r", "m", "c", "i"]);
	});
});

describe("a restore, driven", () => {
	test("preview (paged) → confirm → calls until done, with the cursor; progress adds up", async () => {
		const s = scripted();
		s.previews.push(
			async () => previewPage([entry("a", "delete"), entry("m", "none")], "p1"),
			async () => previewPage([entry("b", "put-back")], null),
		);
		s.restores.push(
			async () =>
				answer({
					cursor: "c1",
					commits: [{ id: "k1", seq: 10 }],
					changed: 2,
					skipped: [{ blockId: "x", sid: "s-x", reason: "lock-kept" }],
					movedAway: 1,
				}),
			async () => answer({ cursor: "c2", commits: [{ id: "k2", seq: 11 }], changed: 1 }),
			async () => answer({ done: true, changed: 0, movedAway: 1 }),
		);
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		expect(run.getState().phase).toBe("preview");
		expect(run.getState().more).toBe(true);
		await run.more();
		expect(run.getState().entries.map((e) => e.blockId)).toEqual(["a", "m", "b"]);
		expect(run.getState().more).toBe(false);
		expect(run.movedAway().map((e) => e.blockId)).toEqual(["m"]);
		await run.confirm();
		const state = run.getState();
		expect(state.phase).toBe("done");
		expect(state.progress.calls).toBe(3);
		expect(state.progress.changed).toBe(3);
		expect(state.progress.commits.map((c) => c.seq)).toEqual([10, 11]);
		expect(state.progress.skipped.map((x) => x.reason)).toEqual(["lock-kept"]);
		expect(s.calls.map((c) => [c.kind, c.body])).toEqual([
			["preview", { rootId: "r", thenSeq: 5 }],
			["preview", { rootId: "r", thenSeq: 5, token: "tok", cursor: "p1" }],
			["restore", { token: "tok" }],
			["restore", { token: "tok", cursor: "c1" }],
			["restore", { token: "tok", cursor: "c2" }],
		]);
	});

	test("stop takes effect between calls; confirming again continues from the cursor", async () => {
		const s = scripted();
		s.previews.push(async () => previewPage([entry("a", "delete")], null));
		let run: RestoreRun | null = null;
		s.restores.push(async () => {
			run?.stop();
			return answer({ cursor: "c1", changed: 1, commits: [{ id: "k1", seq: 10 }] });
		});
		s.restores.push(async () =>
			answer({ done: true, changed: 1, commits: [{ id: "k2", seq: 11 }] }),
		);
		run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.confirm();
		expect(run.getState().phase).toBe("stopped");
		expect(run.getState().progress.changed).toBe(1);
		await run.confirm();
		expect(run.getState().phase).toBe("done");
		expect(run.getState().progress.changed).toBe(2);
		expect(s.calls.at(-1)?.body).toEqual({ token: "tok", cursor: "c1" });
	});

	test("a conflict stops it; trying again previews afresh (no token, no cursor)", async () => {
		const s = scripted();
		s.previews.push(async () => previewPage([entry("a", "delete")], null));
		s.restores.push(
			async () => answer({ cursor: "c1", changed: 1, commits: [{ id: "k1", seq: 10 }] }),
			async () => {
				throw apiError(409, "OUTLINE_RESTORE_CONFLICT", { conflictSeq: 12 });
			},
		);
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.confirm();
		expect(run.getState().phase).toBe("failed");
		expect(run.getState().problem).toEqual({ kind: "conflict", conflictSeq: 12 });
		// What was written before the conflict is said.
		expect(run.getState().progress.changed).toBe(1);
		s.previews.push(async () => previewPage([entry("b", "delete")], null, { token: "tok2" }));
		await run.retry();
		expect(run.getState().phase).toBe("preview");
		expect(run.getState().entries.map((e) => e.blockId)).toEqual(["b"]);
		expect(run.getState().progress.calls).toBe(0);
		expect(s.calls.at(-1)).toEqual({ kind: "preview", body: { rootId: "r", thenSeq: 5 } });
	});

	test("a transient failure while running is retried where it stopped", async () => {
		const s = scripted();
		s.previews.push(async () => previewPage([entry("a", "delete")], null));
		s.restores.push(
			async () => answer({ cursor: "c1", changed: 1 }),
			async () => {
				throw new ApiError("boom", 500, { error: "boom", code: "INTERNAL_ERROR" });
			},
			async () => answer({ done: true, changed: 1 }),
		);
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.confirm();
		expect(run.getState().phase).toBe("failed");
		expect(run.getState().problem?.kind).toBe("other");
		await run.retry();
		expect(run.getState().phase).toBe("done");
		expect(s.calls.at(-1)?.body).toEqual({ token: "tok", cursor: "c1" });
	});

	test("an expired token while paging the preview fails it (preview again)", async () => {
		const s = scripted();
		s.previews.push(
			async () => previewPage([entry("a", "delete")], "p1"),
			async () => {
				throw apiError(400, "OUTLINE_RESTORE_TOKEN_INVALID", { reason: "expired" });
			},
		);
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.more();
		expect(run.getState().phase).toBe("failed");
		expect(run.getState().problem).toEqual({ kind: "expired" });
	});

	test("history not ready on the first page: failed, and trying again previews", async () => {
		const s = scripted();
		s.previews.push(async () => {
			throw apiError(409, "OUTLINE_HISTORY_NOT_READY", { reason: "not-ready", floorSeq: 0 });
		});
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		expect(run.getState().problem).toEqual({ kind: "not-ready" });
		s.previews.push(async () => previewPage([], null));
		await run.retry();
		expect(run.getState().phase).toBe("preview");
	});

	test("move back before confirming: done for that block, and the list is worked out again", async () => {
		const s = scripted();
		s.previews.push(async () => previewPage([entry("a", "delete"), entry("m", "none")], null));
		s.moves.push(async () => ({ commit: { id: "k", seq: 10 } }));
		s.previews.push(async () => previewPage([entry("a", "delete")], null, { token: "tok2" }));
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.moveBack("m");
		const state = run.getState();
		expect(state.moveBack.m?.state).toBe("moved");
		expect(state.refreshed).toBe(1);
		expect(state.entries.map((e) => e.blockId)).toEqual(["a"]);
		expect(s.calls.map((c) => c.kind)).toEqual(["preview", "move-back", "preview"]);
		expect(s.calls[1]?.body).toEqual({ blockId: "m", thenSeq: 5 });
	});

	test("a move back that cannot go says why; after the restore it does not re-preview", async () => {
		const s = scripted();
		s.previews.push(async () => previewPage([entry("m", "none"), entry("n", "none")], null));
		s.restores.push(async () => answer({ done: true }));
		s.moves.push(async () => {
			throw apiError(409, "OUTLINE_RESTORE_PARENT_GONE");
		});
		s.moves.push(async () => ({ commit: { id: "k", seq: 10 } }));
		const run = new RestoreRun(s.io, "r", 5, now);
		await run.preview();
		await run.confirm();
		await run.moveBack("m");
		expect(run.getState().moveBack.m).toEqual({
			state: "failed",
			problem: { kind: "parent-gone" },
		});
		await run.moveBack("n");
		expect(run.getState().moveBack.n?.state).toBe("moved");
		expect(run.getState().phase).toBe("done");
		expect(s.calls.filter((c) => c.kind === "preview")).toHaveLength(1);
	});

	test("an older preview's answer arriving late is dropped", async () => {
		const s = scripted();
		let release: (page: OutlineRestorePreviewResponse) => void = () => {};
		s.previews.push(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
			async () => previewPage([entry("new", "delete")], null, { token: "tok2" }),
		);
		const run = new RestoreRun(s.io, "r", 5, now);
		const first = run.preview();
		await run.preview();
		release(previewPage([entry("old", "delete")], null));
		await first;
		expect(run.getState().entries.map((e) => e.blockId)).toEqual(["new"]);
	});
});
