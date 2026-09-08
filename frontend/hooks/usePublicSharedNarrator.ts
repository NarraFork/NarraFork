import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPublicShareClient } from "../lib/public-share-api";
import { PublicShareSession } from "../lib/public-share-session";

export function usePublicSharedNarrator(shareId: string, credential: string) {
	// A credential change creates an empty store synchronously, before effects can run.
	const controller = useMemo(
		() => new PublicShareSession(createPublicShareClient(shareId, credential)),
		[shareId, credential],
	);
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);
	useEffect(() => {
		controller.start();
		return controller.stop;
	}, [controller]);
	return { controller, state };
}
