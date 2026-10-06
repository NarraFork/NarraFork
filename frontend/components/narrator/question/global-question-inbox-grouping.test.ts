/**
 * Inbox grouping: "this session" vs "elsewhere".
 *
 * This function is what let a whole per-session component be deleted, so the property
 * that matters is conservation: every question lands in exactly one group, none is
 * dropped. A grouping that silently loses a row would look like a working inbox that
 * just happens not to show the question somebody is blocked on.
 */

import { describe, expect, it } from "bun:test";
import { type GlobalQuestion, groupQuestionsByScope } from "./GlobalQuestionInbox";

const q = (id: string, narratorId: string, overrides: Partial<GlobalQuestion> = {}) =>
	({
		id,
		narratorId,
		narratorTitle: `session-${narratorId}`,
		chapterId: null,
		toolCallId: `call-${id}`,
		toolUseId: `tu-${id}`,
		questions: [{ question: "k", header: "h" }],
		answers: null,
		status: "open",
		origin: "agent_async",
		answerMessageId: null,
		decidedBy: null,
		decidedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as GlobalQuestion;

describe("groupQuestionsByScope", () => {
	it("splits the current session's questions from the rest", () => {
		const items = [q("a", "n1"), q("b", "n2"), q("c", "n1")];
		const { current, others } = groupQuestionsByScope(items, "n1");
		expect(current.map((i) => i.id)).toEqual(["a", "c"]);
		expect(others.map((i) => i.id)).toEqual(["b"]);
	});

	it("puts everything in `others` when no session is in view", () => {
		// The dashboard and any non-session page open the drawer without a current
		// narrator; grouping under an empty "this session" heading would be noise.
		const items = [q("a", "n1"), q("b", "n2")];
		const { current, others } = groupQuestionsByScope(items);
		expect(current).toEqual([]);
		expect(others.map((i) => i.id)).toEqual(["a", "b"]);
	});

	it("loses nothing: the two groups always partition the input", () => {
		const items = [q("a", "n1"), q("b", "n2"), q("c", "n3"), q("d", "n1")];
		for (const scope of [undefined, "n1", "n2", "n-unknown"]) {
			const { current, others } = groupQuestionsByScope(items, scope);
			expect(current.length + others.length).toBe(items.length);
			expect([...current, ...others].map((i) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
		}
	});

	it("preserves the server's ordering inside each group", () => {
		// The server already sorts awaited-first, newest-next; regrouping must not reorder
		// within a group or the blocked question stops being the one at the top.
		const items = [
			q("awaited", "n1", { awaited: true }),
			q("newer", "n1", { createdAt: "2026-02-01T00:00:00.000Z" }),
			q("older", "n1", { createdAt: "2026-01-01T00:00:00.000Z" }),
		];
		expect(groupQuestionsByScope(items, "n1").current.map((i) => i.id)).toEqual([
			"awaited",
			"newer",
			"older",
		]);
	});

	it("handles an empty inbox", () => {
		expect(groupQuestionsByScope([], "n1")).toEqual({ current: [], others: [] });
	});
});
