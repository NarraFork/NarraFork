/**
 * Git commit identities, and the per-narrator pick between them.
 *
 * Both queries are personal: the server answers with the CALLER's identities and
 * the caller's pick only, so two people driving one narrator see different menus
 * and never overwrite each other's choice. They share one query-key prefix so an
 * identity edit (which can invalidate every pick — deleting an identity drops it)
 * refreshes the narrator menu as well as the settings list.
 */

import type { GitIdentity } from "@frontend/lib/api/auth";
import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

export interface NarratorGitIdentityState {
	/** The caller's own identities, in the order the settings page shows them. */
	identities: GitIdentity[];
	/** The identity the caller picked for this narrator, or null when they made no pick. */
	selectedId: string | null;
}

const IDENTITIES_KEY = ["auth", "git-identities"] as const;

/** Query key for one caller's pick on one narrator. Shared by the details panel and create flow. */
export function narratorGitIdentityQueryKey(narratorId: string) {
	return [...IDENTITIES_KEY, "narrator", narratorId] as const;
}

/** Every identity write reports the same way: a toast naming what the server refused. */
function useIdentityWriteFailure(): (error: unknown) => void {
	const { t } = useTranslation("common");
	return (error: unknown) => {
		notifications.show({
			color: "red",
			title: t("operationFailed"),
			message: error instanceof Error ? error.message : t("unknownError"),
		});
	};
}

/** The caller's identities. Pass false to skip the request until a surface is actually shown. */
export function useGitIdentities(enabled = true) {
	return useQuery({
		queryKey: IDENTITIES_KEY,
		queryFn: () => api.listGitIdentities(),
		staleTime: 30_000,
		enabled: !REMOTE_BUILD && enabled,
	});
}

/** The caller's pick for one narrator, together with the identities to choose from. */
export function useNarratorGitIdentity(narratorId: string | null) {
	return useQuery({
		queryKey: narratorGitIdentityQueryKey(narratorId ?? ""),
		queryFn: () => api.getNarratorGitIdentity(narratorId as string),
		enabled: !REMOTE_BUILD && !!narratorId,
		staleTime: 30_000,
	});
}

export function useCreateGitIdentity() {
	const qc = useQueryClient();
	const onError = useIdentityWriteFailure();
	return useMutation({
		mutationFn: (data: { name: string; email: string }) => api.createGitIdentity(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: IDENTITIES_KEY }),
		onError,
	});
}

export function useUpdateGitIdentity() {
	const qc = useQueryClient();
	const onError = useIdentityWriteFailure();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			name?: string;
			email?: string;
			isDefault?: true;
		}) => api.updateGitIdentity(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: IDENTITIES_KEY }),
		onError,
	});
}

export function useDeleteGitIdentity() {
	const qc = useQueryClient();
	const onError = useIdentityWriteFailure();
	return useMutation({
		mutationFn: (id: string) => api.deleteGitIdentity(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: IDENTITIES_KEY }),
		onError,
	});
}

/** Pick which of the caller's identities this narrator commits under (null = follow the default). */
export function useSetNarratorGitIdentity(narratorId: string) {
	const qc = useQueryClient();
	const onError = useIdentityWriteFailure();
	return useMutation({
		mutationFn: (identityId: string | null) => api.setNarratorGitIdentity(narratorId, identityId),
		onSuccess: () => qc.invalidateQueries({ queryKey: narratorGitIdentityQueryKey(narratorId) }),
		onError,
	});
}

/** Query key for one caller's pick on one sidebar folder. */
export function folderGitIdentityQueryKey(folderId: string) {
	return [...IDENTITIES_KEY, "folder", folderId] as const;
}

/** The caller's pick for one sidebar folder, together with the identities to choose from. */
export function useFolderGitIdentity(folderId: string | null) {
	return useQuery({
		queryKey: folderGitIdentityQueryKey(folderId ?? ""),
		queryFn: () => api.getFolderGitIdentity(folderId as string),
		enabled: !REMOTE_BUILD && !!folderId,
		staleTime: 30_000,
	});
}

/**
 * Pick which of the caller's identities commits inside one sidebar folder
 * (null = no folder pick, so sessions there follow the default).
 */
export function useSetFolderGitIdentity(folderId: string) {
	const qc = useQueryClient();
	const onError = useIdentityWriteFailure();
	return useMutation({
		mutationFn: (identityId: string | null) => api.setFolderGitIdentity(folderId, identityId),
		onSuccess: () => qc.invalidateQueries({ queryKey: folderGitIdentityQueryKey(folderId) }),
		onError,
	});
}
