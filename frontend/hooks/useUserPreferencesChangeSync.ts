import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

/** Mount once inside the authenticated shell; reconnect recovers hints missed while offline. */
export function useUserPreferencesChangeSync() {
	const qc = useQueryClient();
	useEffect(() => {
		// Prefix invalidation covers both scoped UI and full-detail views, without
		// putting either response shape into the other cache.
		const invalidate = () => {
			void qc.invalidateQueries({ queryKey: ["user-preferences"] });
		};
		const handle = narratorWSManager.addListener(
			{ types: ["user_preferences_changed"] },
			invalidate,
		);
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) invalidate();
		});
		return () => {
			narratorWSManager.removeListener(handle);
			offConnection();
		};
	}, [qc]);
}
