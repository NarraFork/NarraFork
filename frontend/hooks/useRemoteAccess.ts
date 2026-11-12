import { notifications } from "@mantine/notifications";
import type { RemoteAccessSettings } from "@shared/remote-access/management";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { remoteAccessApi } from "../lib/api/remote-access";

export const REMOTE_ACCESS_QUERY_KEY = ["remote-access"] as const;

/** No invitation secrets enter query or mutation caches. */
export function useRemoteAccess(isAdmin: boolean) {
	const qc = useQueryClient();
	const { t } = useTranslation("settings");
	const refresh = () => qc.invalidateQueries({ queryKey: REMOTE_ACCESS_QUERY_KEY });
	const onError = (error: Error) =>
		notifications.show({
			color: "red",
			message: error.message || t("remoteAccess.operationFailed"),
		});
	const status = useQuery({
		queryKey: [...REMOTE_ACCESS_QUERY_KEY, "status"],
		queryFn: ({ signal }) => remoteAccessApi.status(signal),
		enabled: isAdmin,
		retry: false,
		refetchInterval: (query) => (query.state.data?.enabled ? 5000 : false),
	});
	const ready = isAdmin && status.data?.state === "ready";
	const grants = useQuery({
		queryKey: [...REMOTE_ACCESS_QUERY_KEY, "grants", status.data?.instanceId],
		queryFn: ({ signal }) => remoteAccessApi.grants(signal),
		enabled: ready,
		retry: false,
		refetchInterval: ready ? 10_000 : false,
	});
	const configure = useMutation({
		mutationFn: (config: RemoteAccessSettings) => remoteAccessApi.configure(config),
		onSuccess: async () => {
			await refresh();
			notifications.show({ color: "green", message: t("remoteAccess.saved") });
		},
		onError,
	});
	const install = useMutation({
		mutationFn: () => remoteAccessApi.install(),
		onSuccess: async () => {
			await refresh();
			notifications.show({ color: "green", message: t("remoteAccess.installComplete") });
		},
		onError,
	});
	const revokeGrant = useMutation({
		mutationFn: (id: string) => remoteAccessApi.revokeGrant(id),
		onSuccess: async () => {
			await refresh();
			notifications.show({ color: "green", message: t("remoteAccess.revoked") });
		},
		onError,
	});
	return { status, grants, ready, configure, install, revokeGrant, refresh };
}
