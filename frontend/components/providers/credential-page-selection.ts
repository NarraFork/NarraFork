export interface CredentialPageSelectionState {
	allSelected: boolean;
	someSelected: boolean;
}

export function getCredentialPageSelectionState(
	selectedIds: ReadonlySet<string>,
	pageIds: readonly string[],
): CredentialPageSelectionState {
	const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
	return {
		allSelected,
		someSelected: pageIds.some((id) => selectedIds.has(id)) && !allSelected,
	};
}

export function toggleCredentialPageSelection(
	selectedIds: ReadonlySet<string>,
	pageIds: readonly string[],
): Set<string> {
	const next = new Set(selectedIds);
	const { allSelected } = getCredentialPageSelectionState(selectedIds, pageIds);
	for (const id of pageIds) {
		if (allSelected) next.delete(id);
		else next.add(id);
	}
	return next;
}
