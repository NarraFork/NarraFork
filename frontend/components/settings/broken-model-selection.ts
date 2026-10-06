import type { BrokenModelGroup } from "../../lib/api/narrators";

/**
 * Decision rules for the broken-model migration dialog.
 *
 * Kept separate from the component so the selection policy can be verified
 * without rendering: these rules decide what gets rewritten in the database, and
 * a wrong default would silently migrate narrators the user never meant to touch.
 */

/** Stable identity for a scan group (reason + provider prefix). */
export function brokenModelGroupId(group: BrokenModelGroup): string {
	return `${group.reason}\u0000${group.providerPrefix ?? ""}`;
}

/**
 * Which narrators start out selected.
 *
 * Only `provider_missing` is pre-selected: that prefix genuinely no longer
 * resolves, so those narrators cannot run at all. `model_not_listed` is merely
 * absent from the catalog, which a pass-through gateway may still serve, so it
 * must never be migrated without the user opting in.
 */
export function defaultSelectedNarratorIds(groups: readonly BrokenModelGroup[]): Set<string> {
	return new Set(
		groups
			.filter((group) => group.reason === "provider_missing")
			.flatMap((group) => group.narrators.map((narrator) => narrator.id)),
	);
}

/** Per-group checkbox state derived from the current selection. */
export function groupSelectionState(
	group: BrokenModelGroup,
	selectedIds: ReadonlySet<string>,
): { selected: number; allSelected: boolean; someSelected: boolean } {
	const selected = group.narrators.filter((narrator) => selectedIds.has(narrator.id)).length;
	return {
		selected,
		allSelected: selected > 0 && selected === group.narrators.length,
		someSelected: selected > 0 && selected < group.narrators.length,
	};
}

/** Add or remove every narrator in a group, returning a new selection set. */
export function toggleGroupSelection(
	selectedIds: ReadonlySet<string>,
	group: BrokenModelGroup,
	checked: boolean,
): Set<string> {
	const next = new Set(selectedIds);
	for (const narrator of group.narrators) {
		if (checked) next.add(narrator.id);
		else next.delete(narrator.id);
	}
	return next;
}

/**
 * Whether the migrate button may fire.
 *
 * Both conditions are required: a migration with no target model has nothing to
 * write, and one with no selection would be a no-op that still consumes the
 * single undo slot.
 */
export function canConfirmMigration(targetModel: string | null, selectedCount: number): boolean {
	return !!targetModel && selectedCount > 0;
}
