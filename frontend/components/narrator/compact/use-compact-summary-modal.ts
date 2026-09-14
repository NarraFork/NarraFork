import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompactSummaryModalTarget } from "./compact-summary-modal";

/**
 * Owns the compact-summary modal target. Hoisted above the virtualized message
 * rows so a message append / stream update cannot unmount the row and implicitly
 * close the modal. The target is also reset whenever the panel switches narrator,
 * so a modal opened for one narrator does not linger on another.
 *
 * `setTarget` is returned as well: some flows (e.g. clear-context) open the modal
 * with a freshly created target rather than through the context `open`.
 */
export function useCompactSummaryModal(narratorId: string) {
	const [compactSummaryModalTarget, setCompactSummaryModalTarget] =
		useState<CompactSummaryModalTarget | null>(null);
	const compactSummaryModalCtxValue = useMemo(
		() => ({
			open: (target: CompactSummaryModalTarget) => setCompactSummaryModalTarget(target),
		}),
		[],
	);
	const closeCompactSummaryModal = useCallback(() => setCompactSummaryModalTarget(null), []);
	useEffect(() => {
		setCompactSummaryModalTarget((current) =>
			current?.narratorId === narratorId ? current : null,
		);
	}, [narratorId]);

	return {
		compactSummaryModalTarget,
		setCompactSummaryModalTarget,
		compactSummaryModalCtxValue,
		closeCompactSummaryModal,
	};
}
