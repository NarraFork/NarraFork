import { describe, expect, test } from "bun:test";
import type { BrokenModelGroup, BrokenModelReason } from "../../lib/api/narrators";
import {
	brokenModelGroupId,
	canConfirmMigration,
	defaultSelectedNarratorIds,
	groupSelectionState,
	toggleGroupSelection,
} from "./broken-model-selection";

function group(
	reason: BrokenModelReason,
	providerPrefix: string | null,
	ids: string[],
): BrokenModelGroup {
	return {
		providerPrefix,
		reason,
		detail: "detail",
		narrators: ids.map((id) => ({
			id,
			title: `title-${id}`,
			model: `${providerPrefix ?? "none"}:model`,
			status: "idle",
			chapterId: null,
			hasBrokenPendingRestore: false,
		})),
	};
}

describe("default selection", () => {
	test("pre-selects only narrators whose provider is definitely gone", () => {
		const groups = [
			group("provider_missing", "cun", ["a", "b"]),
			group("model_not_listed", "good", ["c"]),
		];

		// An uncatalogued model may still be served by a pass-through gateway, so
		// migrating it without the user opting in would destroy a working choice.
		expect([...defaultSelectedNarratorIds(groups)]).toEqual(["a", "b"]);
	});

	test("selects nothing when every group is only a suspicion", () => {
		expect(defaultSelectedNarratorIds([group("model_not_listed", "good", ["c"])]).size).toBe(0);
	});

	test("handles an empty scan", () => {
		expect(defaultSelectedNarratorIds([]).size).toBe(0);
	});
});

describe("group checkbox state", () => {
	test("reports a fully selected group", () => {
		const g = group("provider_missing", "cun", ["a", "b"]);
		expect(groupSelectionState(g, new Set(["a", "b"]))).toEqual({
			selected: 2,
			allSelected: true,
			someSelected: false,
		});
	});

	test("reports a partially selected group as indeterminate", () => {
		const g = group("provider_missing", "cun", ["a", "b"]);
		expect(groupSelectionState(g, new Set(["a"]))).toEqual({
			selected: 1,
			allSelected: false,
			someSelected: true,
		});
	});

	test("an empty selection is neither checked nor indeterminate", () => {
		const g = group("provider_missing", "cun", ["a", "b"]);
		expect(groupSelectionState(g, new Set())).toEqual({
			selected: 0,
			allSelected: false,
			someSelected: false,
		});
	});
});

describe("group toggle", () => {
	test("adds a whole group without disturbing other selections", () => {
		const next = toggleGroupSelection(
			new Set(["existing"]),
			group("model_not_listed", "good", ["c", "d"]),
			true,
		);
		expect([...next].sort()).toEqual(["c", "d", "existing"]);
	});

	test("removes a whole group without disturbing other selections", () => {
		const next = toggleGroupSelection(
			new Set(["c", "d", "existing"]),
			group("model_not_listed", "good", ["c", "d"]),
			false,
		);
		expect([...next]).toEqual(["existing"]);
	});

	test("returns a new set rather than mutating the current selection", () => {
		const current = new Set(["a"]);
		const next = toggleGroupSelection(current, group("provider_missing", "cun", ["b"]), true);
		expect([...current]).toEqual(["a"]);
		expect(next).not.toBe(current);
	});
});

describe("confirm gate", () => {
	test("requires both a target model and a non-empty selection", () => {
		expect(canConfirmMigration("good:model-a", 3)).toBe(true);
		// No target model: nothing to write.
		expect(canConfirmMigration(null, 3)).toBe(false);
		expect(canConfirmMigration("", 3)).toBe(false);
		// No selection: a no-op that would still consume the single undo slot.
		expect(canConfirmMigration("good:model-a", 0)).toBe(false);
	});
});

describe("group identity", () => {
	test("distinguishes the same prefix flagged for different reasons", () => {
		expect(brokenModelGroupId(group("provider_missing", "good", ["a"]))).not.toBe(
			brokenModelGroupId(group("model_not_listed", "good", ["a"])),
		);
	});

	test("gives prefixless groups a stable key", () => {
		expect(brokenModelGroupId(group("provider_missing", null, ["a"]))).toBe(
			brokenModelGroupId(group("provider_missing", null, ["b"])),
		);
	});
});
