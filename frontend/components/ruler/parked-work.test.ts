import { describe, expect, test } from "bun:test";
import { presentParkedWork, SNAPSHOT_DISPLAY_CHARS, shortSnapshot } from "./parked-work";

describe("presentParkedWork", () => {
	test("a clean rebase shows only the ordinary success toast", () => {
		const result = presentParkedWork({});
		expect(result.notices).toEqual([]);
		expect(result.recoverable).toBeNull();
		expect(result.showSuccess).toBe(true);
	});

	test("a conflicted reapply is yellow and offers recovery", () => {
		const result = presentParkedWork({
			parkedSnapshot: "abc123def456789",
			parkedWorkPending: true,
			parkedWorkStatus: "conflict",
			reapplyConflictFiles: ["src/a.ts", "src/b.ts"],
		});

		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toMatchObject({ kind: "conflict", color: "yellow" });
		// Suppressed: a green "rebase completed" beside this would read as though the
		// parked work were incidental.
		expect(result.showSuccess).toBe(false);
		expect(result.recoverable).toMatchObject({
			snapshot: "abc123def456789",
			status: "conflict",
			conflictFiles: ["src/a.ts", "src/b.ts"],
		});
	});

	test("a failed reapply is red and carries the fault detail", () => {
		// The distinction that did not exist before: a NarraFork/git fault is not a user
		// decision, and reporting it in the conflict's wording misdescribed it.
		const result = presentParkedWork({
			parkedSnapshot: "deadbeefcafe",
			parkedWorkPending: true,
			parkedWorkStatus: "failed",
			reapplyError: "merge-tree exited 128",
		});

		expect(result.notices[0]).toMatchObject({ kind: "failed", color: "red" });
		expect(result.recoverable).toMatchObject({
			status: "failed",
			error: "merge-tree exited 128",
		});
		// Recovery is still offered: the coordinates survive, so a retry may work once the
		// underlying cause is gone.
		expect(result.recoverable).not.toBeNull();
	});

	test("withholds recovery actions when the server says nothing is pending", () => {
		// Without `parkedWorkPending` the endpoint has already cleared the coordinates and
		// would reject every action, so offering them would only produce errors.
		const result = presentParkedWork({
			parkedSnapshot: "abc123",
			parkedWorkStatus: "conflict",
		});

		expect(result.notices).toHaveLength(1);
		expect(result.recoverable).toBeNull();
	});

	test("an unrecoverable earlier snapshot informs without offering actions", () => {
		const result = presentParkedWork({ lostParkedSnapshot: "0badc0de1234" });

		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toMatchObject({ kind: "lost", color: "red" });
		expect(result.recoverable).toBeNull();
		// Still no success toast: the rebase worked, but work was lost, and pairing the two
		// would bury the loss.
		expect(result.showSuccess).toBe(false);
	});

	test("reports a lost snapshot together with newly parked work", () => {
		const result = presentParkedWork({
			lostParkedSnapshot: "0badc0de1234",
			parkedSnapshot: "abc123def456",
			parkedWorkPending: true,
			parkedWorkStatus: "conflict",
		});

		expect(result.notices.map((n) => n.kind)).toEqual(["lost", "conflict"]);
		expect(result.recoverable?.snapshot).toBe("abc123def456");
	});

	test("degrades an unknown status towards being actionable", () => {
		// A value this frontend does not know about should not become a dead end; treating
		// it as a conflict keeps the recovery actions reachable.
		const result = presentParkedWork({
			parkedSnapshot: "abc123",
			parkedWorkPending: true,
		});

		expect(result.recoverable?.status).toBe("conflict");
		expect(result.notices[0].color).toBe("yellow");
	});
});

describe("shortSnapshot", () => {
	test("trims a full snapshot id for display", () => {
		expect(shortSnapshot("0123456789abcdef0123")).toHaveLength(SNAPSHOT_DISPLAY_CHARS);
		expect(shortSnapshot("0123456789abcdef0123")).toBe("0123456789ab");
	});

	test("leaves an already-short id alone", () => {
		expect(shortSnapshot("abc")).toBe("abc");
	});
});
