import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "../../hooks/useAuth";
import { LazyOverlayBoundary } from "../common/LazyOverlayBoundary";

const BrokenModelMigrationModal = lazy(() =>
	import("./BrokenModelMigrationModal").then((m) => ({
		default: m.BrokenModelMigrationModal,
	})),
);

/**
 * Global host for the "narrators pinned to an unusable model" prompt.
 *
 * Mirrors SummaryModelPickerHost: the event listener stays mounted cheaply and the
 * dialog chunk only loads once it is actually needed. Migration rewrites other
 * users' narrator models, so non-admins never see the prompt — they cannot act on it.
 */
export function BrokenModelMigrationHost() {
	const { data: user } = useCurrentUser();
	const [opened, setOpened] = useState(false);
	const dismissedRef = useRef(false);
	const isAdmin = user?.role === "admin";

	useEffect(() => {
		const handle = (event: Event) => {
			if (!isAdmin || dismissedRef.current) return;
			const detail = (event as CustomEvent).detail as
				| { totalBroken?: number; totalSuspect?: number }
				| undefined;
			// Only interrupt for definite breakage. A merely-uncatalogued model may still
			// work, so it must not raise a modal on its own.
			if (!detail?.totalBroken) return;
			setOpened(true);
		};
		window.addEventListener("narrafork:broken-model-narrators", handle);
		return () => window.removeEventListener("narrafork:broken-model-narrators", handle);
	}, [isAdmin]);

	const handleClose = useCallback(() => {
		dismissedRef.current = true;
		setOpened(false);
	}, []);

	if (!opened) return null;

	return (
		// Mounted by the app shell, so an unhandled chunk failure here would otherwise
		// reach the root boundary and unmount the whole shell.
		<LazyOverlayBoundary resetKey={opened}>
			<Suspense fallback={null}>
				<BrokenModelMigrationModal opened={opened} onClose={handleClose} />
			</Suspense>
		</LazyOverlayBoundary>
	);
}
