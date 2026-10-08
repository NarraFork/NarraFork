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

const narratorPickKey = (narratorId: string) =>
	[...IDENTITIES_KEY, "narrator", narratorId] as const;

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

/** The caller's identities. */
export function useGitIdentities() {
	return useQuery({
		queryKey: IDENTITIES_KEY,
		queryFn: () => api.listGitIdentities(),
		staleTime: 30_000,
	});
}

/** The caller's pick for one narrator, together with the identities to choose from. */
export function useNarratorGitIdentity(narratorId: string | null) {
	return useQuery({
		queryKey: narratorPickKey(narratorId ?? ""),
		queryFn: () => api.getNarratorGitIdentity(narratorId as string),
		enabled: !!narratorId,
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
		onSuccess: () => qc.invalidateQueries({ queryKey: narratorPickKey(narratorId) }),
		onError,
	});
}
