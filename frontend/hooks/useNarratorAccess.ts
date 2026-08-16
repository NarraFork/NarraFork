import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { NarratorGrantAccess, NarratorVisibility } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { queryClient } from "../lib/query-client";

const NARRATOR_ACCESS_GC_TIME_MS = 60_000;

export const narratorAccessKeys = {
	access: (narratorId: string) => ["narrators", narratorId, "access"] as const,
};

/**
 * Keep access state fresh when it is changed elsewhere.
 *
 * `narrator_access_changed` is broadcast per user rather than per subscription (a
 * change can affect someone who is not watching the narrator at all), so this is a
 * standing global listener installed once, not a per-panel subscription. The frame
 * carries no grant detail on purpose, so the only correct reaction is to re-read.
 */
let accessListenerInstalled = false;

export function installNarratorAccessListener() {
	if (accessListenerInstalled) return;
	accessListenerInstalled = true;
	narratorWSManager.addListener(
		{ narratorIds: "*", types: ["narrator_access_changed"] },
		(data) => {
			const narratorId = typeof data.narratorId === "string" ? data.narratorId : null;
			if (narratorId) {
				queryClient.invalidateQueries({ queryKey: narratorAccessKeys.access(narratorId) });
			}
			// Sharing decides who appears in whose list, so the lists are refreshed too.
			queryClient.invalidateQueries({ queryKey: ["narrators"] });
		},
	);
}

/**
 * Current sharing state of a narrator: visibility, owner and the per-user grants.
 *
 * Only fetched when a panel actually needs it — the endpoint reads the grant rows,
 * which no other view wants. Invalidated by the `narrator_access_changed` WebSocket
 * frame, so a change made in another tab (or by an admin) shows up without a reload.
 */
export function useNarratorAccess(narratorId: string | undefined, enabled = true) {
	installNarratorAccessListener();
	return useQuery({
		queryKey: narratorAccessKeys.access(narratorId ?? ""),
		queryFn: () => api.getNarratorAccess(narratorId as string),
		enabled: enabled && !!narratorId,
		gcTime: NARRATOR_ACCESS_GC_TIME_MS,
	});
}

/**
 * The sharing mutations.
 *
 * Every one invalidates the access query rather than patching the cache locally: the
 * server decides the resulting state (a batch can partly fail, and a visibility
 * change can strip grants' relevance), so echoing an optimistic guess would risk
 * showing an access list that does not match reality.
 *
 * The narrator lists are invalidated too, because sharing changes who appears in
 * whose list.
 */
export function useNarratorAccessMutations(narratorId: string) {
	const queryClient = useQueryClient();
	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: narratorAccessKeys.access(narratorId) });
		queryClient.invalidateQueries({ queryKey: ["narrators"] });
	};

	const setVisibility = useMutation({
		mutationFn: (visibility: NarratorVisibility) =>
			api.setNarratorVisibility(narratorId, visibility),
		onSuccess: invalidate,
	});

	const grant = useMutation({
		mutationFn: ({ userIds, access }: { userIds: string[]; access: NarratorGrantAccess }) =>
			api.grantNarratorAccess(narratorId, userIds, access),
		onSuccess: invalidate,
	});

	const updateGrant = useMutation({
		mutationFn: ({ grantId, access }: { grantId: string; access: NarratorGrantAccess }) =>
			api.updateNarratorGrant(narratorId, grantId, access),
		onSuccess: invalidate,
	});

	const revokeGrant = useMutation({
		mutationFn: (grantId: string) => api.revokeNarratorGrant(narratorId, grantId),
		onSuccess: invalidate,
	});

	const transferOwner = useMutation({
		mutationFn: (userId: string | null) => api.transferNarratorOwner(narratorId, userId),
		onSuccess: invalidate,
	});

	return { setVisibility, grant, updateGrant, revokeGrant, transferOwner };
}
