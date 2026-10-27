interface ModelTraceReturnOptions {
	narrator: {
		parentNarratorId?: string | null;
		navigationSummary?: { parentNarratorId: string | null };
	};
	onClose?: () => void;
	navigateToNarrator: (id: string) => void;
	navigateToDefault: () => void;
}

/** The child adapter's close belongs to this panel, never to its source narrator. */
export function returnFromModelTrace({
	narrator,
	onClose,
	navigateToNarrator,
	navigateToDefault,
}: ModelTraceReturnOptions) {
	if (onClose) {
		onClose();
		return;
	}
	// Authorized navigation metadata also handles deleted/inaccessible parents.
	const parentId = narrator.navigationSummary
		? narrator.navigationSummary.parentNarratorId
		: narrator.parentNarratorId;
	if (parentId) navigateToNarrator(parentId);
	else navigateToDefault();
}
