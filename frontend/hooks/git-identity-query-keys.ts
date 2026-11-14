/**
 * Query keys for git identities, kept apart from the hooks so layout code (the sidebar's
 * tab moves) can invalidate them without pulling in the identity hooks.
 *
 * Everything shares one prefix: an identity edit can change every pick's meaning.
 */
import type { QueryClient } from "@tanstack/react-query";

export const GIT_IDENTITIES_QUERY_KEY = ["auth", "git-identities"] as const;

const NARRATOR_GIT_IDENTITY_PREFIX = [...GIT_IDENTITIES_QUERY_KEY, "narrator"] as const;

/** Query key for one caller's pick on one narrator. Shared by the details panel and create flow. */
export function narratorGitIdentityQueryKey(narratorId: string) {
	return [...NARRATOR_GIT_IDENTITY_PREFIX, narratorId] as const;
}

/** Query key for one caller's pick on one sidebar folder. */
export function folderGitIdentityQueryKey(folderId: string) {
	return [...GIT_IDENTITIES_QUERY_KEY, "folder", folderId] as const;
}

/**
 * Refresh every narrator's pick state.
 *
 * A narrator with no pick of its own follows its sidebar folder, and the server reports
 * that folder's pick alongside the narrator's. Changing a folder's pick, or moving a
 * session between folders, therefore changes what those menus must say.
 */
export function invalidateNarratorGitIdentities(qc: QueryClient): Promise<void> {
	return qc.invalidateQueries({ queryKey: NARRATOR_GIT_IDENTITY_PREFIX });
}
