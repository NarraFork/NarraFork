import type { PendingAgentMessagesPage } from "@shared/agent-inbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../../../lib/api";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";

export const pendingAgentMessagesQueryKey = (narratorId: string) =>
	["narrator-agent-inbox", narratorId] as const;

/** The inbox's running/blockedReason values remain authoritative server state. */
export function usePendingAgentMessages(narratorId: string) {
	const queryClient = useQueryClient();
	const query = useQuery<PendingAgentMessagesPage>({
		queryKey: pendingAgentMessagesQueryKey(narratorId),
		queryFn: ({ signal }) => api.getPendingAgentMessages(narratorId, signal),
		staleTime: 5_000,
	});
	const refreshRef = useRef<() => Promise<void>>(async () => {});
	const refresh = useCallback(() => refreshRef.current(), []);

	useEffect(() => {
		const queryKey = pendingAgentMessagesQueryKey(narratorId);
		let disposed = false;
		let active: Promise<void> | null = null;
		let trailing = false;
		let previousStatus = queryClient.getQueryData<{ status: string }>([
			"narrators",
			narratorId,
		])?.status;
		const request = (): Promise<void> => {
			if (disposed) return Promise.resolve();
			if (active) {
				trailing = true;
				return active;
			}
			active = Promise.resolve()
				.then(async () => {
					// Cancel even the initial no-data read: an older snapshot must not win the event.
					await queryClient.cancelQueries({ queryKey, exact: true });
					if (disposed) return;
					trailing = false; // All requests before this read starts are covered by it.
					await queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
					if (!disposed && trailing) {
						trailing = false;
						// Notifications during the read get one trailing read, not cancel/restart churn.
						await queryClient.invalidateQueries(
							{ queryKey, exact: true },
							{ cancelRefetch: false },
						);
					}
				})
				.finally(() => {
					active = null;
					// A new change during the trailing read forms the next batch.
					if (!disposed && trailing) void request();
				});
			return active;
		};
		refreshRef.current = request;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["agent_inbox_changed", "status_change"] },
			(frame) => {
				if (frame.type === "status_change") {
					if (typeof frame.status !== "string") return;
					const status = frame.status;
					const running = status === "working" || status === "waiting";
					const wasRunning = previousStatus
						? previousStatus === "working" || previousStatus === "waiting"
						: queryClient.getQueryData<PendingAgentMessagesPage>(queryKey)?.running;
					// With no baseline yet, the initial in-flight read may predate this edge.
					const changed =
						wasRunning === undefined ||
						wasRunning !== running ||
						(!running && previousStatus !== undefined && previousStatus !== status);
					previousStatus = status;
					if (!changed) return;
				}
				void request();
			},
		);
		const offConnection = narratorWSManager.onConnectionChange((connected) => {
			if (connected) void request();
		});
		const offRecovery = narratorWSManager.onControlPlaneRecovery(() => void request());
		return () => {
			disposed = true;
			refreshRef.current = async () => {};
			narratorWSManager.removeListener(handle);
			offConnection();
			offRecovery();
			void queryClient.cancelQueries({ queryKey, exact: true });
		};
	}, [narratorId, queryClient]);

	return { ...query, refresh };
}
