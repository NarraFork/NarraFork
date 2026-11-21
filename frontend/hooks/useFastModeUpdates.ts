import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export interface FastModeChangedMessage {
	type: "fast_mode_changed";
	refreshPreferences?: boolean;
}

/** Details only: lists, messages and hidden/disabled queries must not start extra reads. */
export function invalidateFastModeDetails(client: QueryClient) {
	return client.invalidateQueries({
		predicate: ({ queryKey }) =>
			queryKey.length === 2 && queryKey[0] === "narrators" && typeof queryKey[1] === "string",
		refetchType: "active",
	});
}

/** Mounted once in the authenticated shell; no narrator/body subscription is needed. */
export function useFastModeUpdates(enabled = true) {
	const client = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let refreshPreferences = false;
		let disposed = false;
		const schedule = (preferences: boolean) => {
			if (disposed) return;
			refreshPreferences ||= preferences;
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				void invalidateFastModeDetails(client);
				if (refreshPreferences) {
					void client.invalidateQueries({ queryKey: ["user-preferences"], exact: true });
				}
				refreshPreferences = false;
			}, 100);
		};
		const listener = narratorWSManager.addListener({ types: ["fast_mode_changed"] }, (message) => {
			schedule(message.refreshPreferences === true);
		});
		const offConnection = narratorWSManager.onConnectionChange((connected) => {
			// The first connection also repairs an HTTP-read → WS-connect race.
			if (connected) schedule(true);
		});
		return () => {
			disposed = true;
			narratorWSManager.removeListener(listener);
			offConnection();
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [client, enabled]);
}
