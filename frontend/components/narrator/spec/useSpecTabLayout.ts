import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { getAuthSnapshot, subscribeAuth } from "../../../lib/api/client";
import { EMPTY_SPEC_TAB_LAYOUT, type SpecTabLayout } from "./spec-tab-order";
import { createSpecTabLayoutSaver } from "./spec-tab-save";

/** A current-narrator point read; historical layout maps never enter the UI cache. */
export function useSpecTabLayout(narratorId: string) {
	const queryClient = useQueryClient();
	const { generation, hasToken } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	const queryKey = useMemo(
		() => ["user-preferences", "spec-tab-layout", generation, narratorId] as const,
		[generation, narratorId],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: writes are scoped to this exact account/narrator key.
	const writes = useMemo(() => ({ epoch: 0, pending: 0 }), [queryKey]);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			if (getAuthSnapshot().generation !== generation) throw new Error("Session changed");
			const epoch = writes.epoch;
			const result = await api.getSpecTabLayout(narratorId, { signal });
			if (getAuthSnapshot().generation !== generation) throw new Error("Session changed");
			// Account events may refetch while a newer local gesture is being saved.
			if (writes.pending || writes.epoch !== epoch) {
				return queryClient.getQueryData<SpecTabLayout>(queryKey) ?? result;
			}
			return result;
		},
		enabled: hasToken && !!narratorId,
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
					if (getAuthSnapshot().generation !== generation) return;
					writes.epoch++;
					queryClient.setQueryData<SpecTabLayout>(queryKey, next);
				},
				persist: async (next) => {
					if (getAuthSnapshot().generation !== generation) throw new Error("Session changed");
					writes.pending++;
					const controller = new AbortController();
					const offAuth = subscribeAuth(() => {
						if (getAuthSnapshot().generation !== generation)
							controller.abort(new Error("Session changed"));
					});
					try {
						await api.saveSpecTabLayout(narratorId, next, { signal: controller.signal });
						if (getAuthSnapshot().generation !== generation) return;
						void queryClient.invalidateQueries({ queryKey: ["user-preferences", "detail"] });
					} finally {
						offAuth();
						writes.pending--;
					}
				},
				onPersistError: () => {
					if (getAuthSnapshot().generation === generation) reportError.current();
				},
			}),
		[generation, narratorId, queryClient, queryKey, writes],
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
