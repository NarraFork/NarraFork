import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { api } from "../../../lib/api";
import { getToken, onTokenChange } from "../../../lib/api/client";
import { EMPTY_SPEC_TAB_LAYOUT, type SpecTabLayout } from "./spec-tab-order";
import { createSpecTabLayoutSaver } from "./spec-tab-save";

function subscribeToken(listener: () => void) {
	const off = onTokenChange(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === "narrafork_token" || event.key === null) listener();
	};
	if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
	return () => {
		off();
		if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
	};
}

/** A current-narrator point read; historical layout maps never enter the UI cache. */
export function useSpecTabLayout(narratorId: string) {
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const token = useSyncExternalStore(subscribeToken, getToken, () => null);
	const queryKey = useMemo(
		() => ["user-preferences", "spec-tab-layout", token, user?.id, narratorId] as const,
		[token, user?.id, narratorId],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: writes are scoped to this exact account/narrator key.
	const writes = useMemo(() => ({ epoch: 0, pending: 0 }), [queryKey]);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			if (getToken() !== token) throw new Error("Session changed");
			const epoch = writes.epoch;
			const result = await api.getSpecTabLayout(narratorId, { signal });
			if (getToken() !== token) throw new Error("Session changed");
			// Account events may refetch while a newer local gesture is being saved.
			if (writes.pending || writes.epoch !== epoch) {
				return queryClient.getQueryData<SpecTabLayout>(queryKey) ?? result;
			}
			return result;
		},
		enabled: !!token && !!user?.id && !!narratorId,
		staleTime: 30_000,
		gcTime: 60_000,
	});
	const { t } = useTranslation("narrator");
	const reportError = useRef<() => void>(() => {});
	reportError.current = () => {
		notifications.show({
			color: "red",
			title: t("spec.saveError"),
			message: t("spec.tabLayoutSaveError"),
		});
	};
	const saver = useMemo(
		() =>
			createSpecTabLayoutSaver({
				readLoadedLayout: () => queryClient.getQueryData<SpecTabLayout>(queryKey) ?? null,
				writeLayout: (next) => {
					if (getToken() !== token) return;
					writes.epoch++;
					queryClient.setQueryData<SpecTabLayout>(queryKey, next);
				},
				persist: async (next) => {
					if (getToken() !== token) throw new Error("Session changed");
					writes.pending++;
					const controller = new AbortController();
					const offToken = subscribeToken(() => {
						if (getToken() !== token) controller.abort(new Error("Session changed"));
					});
					try {
						await api.saveSpecTabLayout(narratorId, next, { signal: controller.signal });
						if (getToken() !== token) return;
						void queryClient.invalidateQueries({ queryKey: ["user-preferences", "detail"] });
					} finally {
						offToken();
						writes.pending--;
					}
				},
				onPersistError: () => {
					if (getToken() === token) reportError.current();
				},
			}),
		[narratorId, queryClient, queryKey, token, writes],
	);
	const save = useCallback(
		(mutate: (current: SpecTabLayout) => SpecTabLayout) => {
			void queryClient.cancelQueries({ queryKey, exact: true }, { revert: false });
			saver.save(mutate);
		},
		[saver, queryClient, queryKey],
	);
	return { layout: query.data ?? EMPTY_SPEC_TAB_LAYOUT, save };
}
