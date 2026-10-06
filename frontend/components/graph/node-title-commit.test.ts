import { describe, expect, test } from "bun:test";
import { resolveTitleCommit } from "./node-title-commit";

describe("resolveTitleCommit", () => {
	test("saves a changed title, trimmed", () => {
		expect(
			resolveTitleCommit({
				draft: "  New title  ",
				currentTitle: "Old title",
				alreadyCommitted: false,
			}),
		).toEqual({ action: "save", title: "New title" });
	});

	test("discards an unchanged title", () => {
		expect(
			resolveTitleCommit({ draft: "Same", currentTitle: "Same", alreadyCommitted: false }),
		).toEqual({ action: "discard", reason: "unchanged" });
	});

	test("a title differing only in surrounding space counts as unchanged", () => {
		expect(
			resolveTitleCommit({ draft: "  Same  ", currentTitle: "Same", alreadyCommitted: false }),
		).toEqual({ action: "discard", reason: "unchanged" });
	});

	test("discards a blank title instead of blanking the node header", () => {
		expect(
			resolveTitleCommit({ draft: "   ", currentTitle: "Old title", alreadyCommitted: false }),
		).toEqual({ action: "discard", reason: "empty" });
		expect(
			resolveTitleCommit({ draft: "", currentTitle: "Old title", alreadyCommitted: false }),
		).toEqual({ action: "discard", reason: "empty" });
	});

	/**
	 * Enter saves AND blurs the input, so the blur handler runs right after. Without
	 * the guard the same edit is submitted twice — two PATCHes, the second racing the
	 * first's invalidation.
	 */
	test("ignores a second commit for the same edit", () => {
		expect(
			resolveTitleCommit({ draft: "New title", currentTitle: "Old", alreadyCommitted: true }),
		).toEqual({ action: "ignore", reason: "already-committed" });
	});

	test("the committed guard wins over every other outcome", () => {
		for (const draft of ["", "   ", "Old", "Something else"]) {
			expect(
				resolveTitleCommit({ draft, currentTitle: "Old", alreadyCommitted: true }).action,
			).toBe("ignore");
		}
	});
});
