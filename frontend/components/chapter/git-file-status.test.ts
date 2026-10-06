/**
 * Badge letter for a file row in the git panel.
 *
 * The regression these lock: a porcelain status is TWO independent characters,
 * and the badge used to be built by stripping spaces from the pair. That turned
 * every genuinely-two-sided status (`AM`, `MM`, `AD`) into an unmapped key that
 * fell through to the gray fallback, and it made a brand-new untracked file read
 * as `??` instead of an addition.
 */

import { describe, expect, test } from "bun:test";
import { statusRegistry } from "../../lib/status-registry";
import { gitFileBadgeChar, isUnmergedStatus } from "./git-file-status";

describe("gitFileBadgeChar", () => {
	test("a brand-new untracked file reads as an addition", () => {
		// The user created it; `??` only means "not in the index", which the
		// section heading already says.
		expect(gitFileBadgeChar("??", "unstaged")).toBe("A");
	});

	test("a staged brand-new file reads as an addition", () => {
		expect(gitFileBadgeChar("A ", "staged")).toBe("A");
	});

	test("a new file staged then edited again shows A staged and M unstaged", () => {
		// `AM` is the exact case that used to render as a gray two-letter blob.
		expect(gitFileBadgeChar("AM", "staged")).toBe("A");
		expect(gitFileBadgeChar("AM", "unstaged")).toBe("M");
	});

	test("picks the section's own half for ordinary edits", () => {
		expect(gitFileBadgeChar("M ", "staged")).toBe("M");
		expect(gitFileBadgeChar(" M", "unstaged")).toBe("M");
		expect(gitFileBadgeChar("MM", "staged")).toBe("M");
		expect(gitFileBadgeChar("MM", "unstaged")).toBe("M");
	});

	test("reports deletions on the side that deleted", () => {
		expect(gitFileBadgeChar("D ", "staged")).toBe("D");
		expect(gitFileBadgeChar(" D", "unstaged")).toBe("D");
		// Staged as an addition, then deleted from the worktree.
		expect(gitFileBadgeChar("AD", "staged")).toBe("A");
		expect(gitFileBadgeChar("AD", "unstaged")).toBe("D");
	});

	test("keeps renames and copies", () => {
		expect(gitFileBadgeChar("R ", "staged")).toBe("R");
		expect(gitFileBadgeChar("RM", "unstaged")).toBe("M");
		expect(gitFileBadgeChar("C ", "staged")).toBe("C");
	});

	test("falls back to the other half when its own says nothing", () => {
		// A row can be listed for one section while only the other half carries a
		// verdict; showing the real letter beats showing a placeholder.
		expect(gitFileBadgeChar("M ", "unstaged")).toBe("M");
		expect(gitFileBadgeChar(" D", "staged")).toBe("D");
	});

	test("marks merge conflicts on both sides", () => {
		for (const status of ["UU", "AU", "UA", "DU", "UD", "AA", "DD"]) {
			expect(gitFileBadgeChar(status, "staged")).toBe("U");
			expect(gitFileBadgeChar(status, "unstaged")).toBe("U");
		}
	});

	test("degrades to M rather than emitting an unmapped key", () => {
		for (const status of ["", " ", "  ", "XY", "!"]) {
			expect(gitFileBadgeChar(status, "staged")).toBe("M");
		}
	});

	test("every letter it can return is a known registry key", () => {
		// This is the actual invariant the old code broke: an unknown key silently
		// loses its colour.
		const statuses = [
			"A ",
			"AM",
			"AD",
			"M ",
			" M",
			"MM",
			"D ",
			" D",
			"R ",
			"RM",
			"C ",
			"UU",
			"AA",
			"DD",
			"??",
			"XY",
			"",
		];
		const fallbackColor = statusRegistry.gitFileStatus("definitely-unmapped").color;
		for (const status of statuses) {
			for (const section of ["staged", "unstaged"] as const) {
				const char = gitFileBadgeChar(status, section);
				expect(char).toHaveLength(1);
				expect(statusRegistry.gitFileStatus(char).color).not.toBe(fallbackColor);
			}
		}
	});

	test("the old strip-spaces approach is what produced unmapped keys", () => {
		// Guards the intent, not the implementation: if someone reverts to
		// concatenating both halves, these are the keys that lose their colour.
		const fallbackColor = statusRegistry.gitFileStatus("definitely-unmapped").color;
		for (const status of ["AM", "MM", "AD", "RM"]) {
			const legacy = status.replace(/\s/g, "") || "M";
			expect(statusRegistry.gitFileStatus(legacy).color).toBe(fallbackColor);
			// The new mapping keeps a colour for the same input.
			expect(statusRegistry.gitFileStatus(gitFileBadgeChar(status, "staged")).color).not.toBe(
				fallbackColor,
			);
		}
	});
});

describe("isUnmergedStatus", () => {
	test("detects U on either side plus the AA/DD pairs", () => {
		for (const status of ["UU", "AU", "UA", "DU", "UD", "AA", "DD"]) {
			expect(isUnmergedStatus(status)).toBe(true);
		}
	});

	test("does not fire on ordinary statuses", () => {
		for (const status of ["A ", "AM", "M ", " M", "MM", "D ", " D", "R ", "??", ""]) {
			expect(isUnmergedStatus(status)).toBe(false);
		}
	});
});
