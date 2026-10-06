import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ProjectRole, ProjectVisibility } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { queryClient } from "../lib/query-client";

const PROJECT_ACCESS_GC_TIME_MS = 60_000;

export const projectAccessKeys = {
	access: (projectId: string) => ["projects", projectId, "access"] as const,
};

/**
 * Keep project access state fresh when it changes elsewhere.
 *
 * `project_access_changed` is broadcast per affected user, not per subscription — a
 * membership change most concerns someone who is not currently looking at the project
 * (they just lost it). So this is one standing global listener, not a per-panel
 * subscription. The frame deliberately carries no membership detail, so the only
 * correct reaction is to re-read.
 */
let accessListenerInstalled = false;

export function installProjectAccessListener() {
	if (accessListenerInstalled) return;
	accessListenerInstalled = true;
	narratorWSManager.addListener({ narratorIds: "*", types: ["project_access_changed"] }, (data) => {
		const projectId = typeof data.projectId === "string" ? data.projectId : null;
		if (projectId) {
			queryClient.invalidateQueries({ queryKey: projectAccessKeys.access(projectId) });
		}
		// Membership decides which projects appear in whose list, and the project gate
		// sits above chapters and sessions, so those lists are refreshed too.
		queryClient.invalidateQueries({ queryKey: ["projects"] });
		queryClient.invalidateQueries({ queryKey: ["chapters"] });
		queryClient.invalidateQueries({ queryKey: ["narrators"] });
	});
}

/**
 * Current membership state of a project: visibility, owner and the per-user tiers.
 *
 * Only fetched when a panel needs it — the endpoint reads grant rows that no other
 * view wants.
 */
export function useProjectAccess(projectId: string | undefined, enabled = true) {
	installProjectAccessListener();
	return useQuery({
		queryKey: projectAccessKeys.access(projectId ?? ""),
		queryFn: () => api.getProjectAccess(projectId as string),
		enabled: enabled && !!projectId,
		gcTime: PROJECT_ACCESS_GC_TIME_MS,
	});
}

/**
 * The membership mutations.
 *
 * Every one invalidates rather than patching the cache: the server decides the
 * resulting state (a batch can partly fail, and the owner cannot be demoted to a
 * member), so echoing an optimistic guess risks showing a member list that does not
 * match reality.
 */
export function useProjectAccessMutations(projectId: string) {
	const queryClient = useQueryClient();
	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: projectAccessKeys.access(projectId) });
		queryClient.invalidateQueries({ queryKey: ["projects"] });
	};

	const setVisibility = useMutation({
		mutationFn: (visibility: ProjectVisibility) => api.setProjectVisibility(projectId, visibility),
		onSuccess: invalidate,
	});

	const addMembers = useMutation({
		mutationFn: ({ userIds, role }: { userIds: string[]; role: ProjectRole }) =>
			api.addProjectMembers(projectId, userIds, role),
		onSuccess: invalidate,
	});

	const removeMember = useMutation({
		mutationFn: (userId: string) => api.removeProjectMember(projectId, userId),
		onSuccess: invalidate,
	});

	const transferOwner = useMutation({
		mutationFn: (userId: string) => api.transferProjectOwner(projectId, userId),
		onSuccess: invalidate,
	});

	return { setVisibility, addMembers, removeMember, transferOwner };
}
