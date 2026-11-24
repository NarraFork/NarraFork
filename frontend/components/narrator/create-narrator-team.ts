/**
 * "Start as a team" in the new-session dialog: can the chosen directory get a team?
 *
 * A team is a coordinator session plus its row in a project, so the directory has to resolve
 * to a git project the user may write in, by the same rules as a session's working directory
 * (the server's project index, through `POST /api/projects/resolve-directory`). This module only
 * LOOKS (`create: false`); the project of a repository that has none is made at submit time.
 *
 * Kept free of router and Mantine imports: the dialog renders the switch on every open, and its
 * tests mock those modules.
 */
import type { ResolveProjectDirectoryResponse } from "@shared/project-directory";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";

/** Typing a path fires a lookup per keystroke without this. */
const LOOKUP_DEBOUNCE_MS = 300;
const LOOKUP_STALE_MS = 30_000;

/** Why the team option is off, as an i18n key suffix under `narrators:teamStart.reason.*`. */
export type TeamStartBlock =
	| "remoteDevice"
	| "chooseDirectory"
	| "checking"
	| "postgres"
	| "lookupFailed"
	| "notDirectory"
	| "notGit"
	| "noAccess"
	| "archived"
	| "readOnly";

export type TeamStartEligibility =
	| { ok: true; project: { id: string; name: string } }
	| { ok: true; repositoryRoot: string }
	| { ok: false; reason: TeamStartBlock };

export interface TeamStartLookup {
	isRemoteDevice: boolean;
	cwd: string;
	/** The debounced directory the lookup below answers for. */
	lookedUpCwd: string;
	isLoading: boolean;
	error: unknown;
	data: ResolveProjectDirectoryResponse | undefined;
}

/** Whether a failure is the server refusing teams on PostgreSQL (503). */
function postgresRefusal(error: unknown): boolean {
	return (error as { status?: unknown } | null)?.status === 503;
}

/** Pure: the option's state from the inputs and the lookup's answer. */
export function teamStartEligibility(input: TeamStartLookup): TeamStartEligibility {
	if (input.isRemoteDevice) return { ok: false, reason: "remoteDevice" };
	const cwd = input.cwd.trim();
	if (!cwd) return { ok: false, reason: "chooseDirectory" };
	if (input.error) {
		return { ok: false, reason: postgresRefusal(input.error) ? "postgres" : "lookupFailed" };
	}
	const data = input.data;
	// An answer for a directory the user has since changed is no answer.
	if (input.isLoading || input.lookedUpCwd !== cwd || !data || typeof data.status !== "string")
		return { ok: false, reason: "checking" };
	switch (data.status) {
		case "project":
			if (data.project.archived) return { ok: false, reason: "archived" };
			if (!data.project.canWrite) return { ok: false, reason: "readOnly" };
			return { ok: true, project: { id: data.project.id, name: data.project.name } };
		case "repository":
			return { ok: true, repositoryRoot: data.root };
		case "not_git":
			return { ok: false, reason: "notGit" };
		case "not_directory":
			return { ok: false, reason: "notDirectory" };
		case "no_access":
			return { ok: false, reason: "noAccess" };
		default:
			return { ok: false, reason: "checking" };
	}
}

export function resolveDirectoryQueryKey(cwd: string) {
	return ["projects", "resolve-directory", cwd] as const;
}

/** Looks the chosen directory up while the dialog is open; never creates a project. */
export function useTeamStartEligibility({
	opened,
	cwd,
	isRemoteDevice,
}: {
	opened: boolean;
	cwd: string;
	isRemoteDevice: boolean;
}): TeamStartEligibility {
	const trimmed = cwd.trim();
	const [lookedUpCwd, setLookedUpCwd] = useState(trimmed);
	useEffect(() => {
		const timer = setTimeout(() => setLookedUpCwd(trimmed), LOOKUP_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [trimmed]);
	const query = useQuery({
		queryKey: resolveDirectoryQueryKey(lookedUpCwd),
		queryFn: () => api.resolveProjectDirectory({ cwd: lookedUpCwd, create: false }),
		enabled: opened && !isRemoteDevice && lookedUpCwd.length > 0,
		staleTime: LOOKUP_STALE_MS,
		// A 503 (PostgreSQL) or a 4xx will not change on a retry; the dialog says why.
		retry: false,
	});
	return teamStartEligibility({
		isRemoteDevice,
		cwd: trimmed,
		lookedUpCwd,
		isLoading: query.isLoading,
		error: query.error,
		data: query.data as ResolveProjectDirectoryResponse | undefined,
	});
}
