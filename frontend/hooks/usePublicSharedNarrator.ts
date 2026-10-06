import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPublicShareClient } from "../lib/public-share-api";
import { PublicShareSession } from "../lib/public-share-session";

export function usePublicSharedNarrator(shareId: string, credential: string) {
	// A credential change creates an empty store synchronously, before effects can run.
	const client = useMemo(() => createPublicShareClient(shareId, credential), [shareId, credential]);
	const controller = useMemo(
		() => new PublicShareSession(client, shareId, credential),
		[client, shareId, credential],
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
	return { client, controller, state };
}
