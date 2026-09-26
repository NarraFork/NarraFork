import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginKeys, usePlugin, usePluginPermissionRequests } from "../../hooks/usePlugins";
import { pluginsApi } from "../../lib/api/plugins";
import { localizePluginError } from "./errors";
import { PendingRequestRow } from "./PendingRequestRow";

export interface PluginPermissionRequestModalProps {
	pluginId: string;
	/**
	 * Close the prompt. Request ids passed here are treated as "later" and are
	 * not re-prompted for the rest of the session; an empty list means every
	 * request was decided.
	 */
	onClose: (dismissedRequestIds: string[]) => void;
}

/**
 * Global admin prompt for plugin permission requests. The WS event only carries
 * the request id, so the full pending list (scope, source, timestamps) is read
 * through the same React Query hooks as the grants tab — polling there doubles
 * as the reconnect fallback, and decisions made on the grants tab close this
 * prompt automatically.
 */
export function PluginPermissionRequestModal({
	pluginId,
	onClose,
}: PluginPermissionRequestModalProps) {
	const { t } = useTranslation("plugins");
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pluginQuery = usePlugin(pluginId);
	const pendingQuery = usePluginPermissionRequests(pluginId);
	const pendingRequests = pendingQuery.data ?? [];
	const pluginName = pluginQuery.data?.displayName ?? pluginId;

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: pluginKeys.permissionRequests(pluginId) });
		void queryClient.invalidateQueries({ queryKey: pluginKeys.grants(pluginId) });
		void queryClient.invalidateQueries({ queryKey: pluginKeys.permanentDenials(pluginId) });
		void queryClient.invalidateQueries({ queryKey: pluginKeys.detail(pluginId) });
	};

	// The prompt was opened by a fresh request event, so whatever list is cached
	// (possibly an empty list from the previous decision, still within gcTime or
	// even staleTime) predates it. Force a refetch on mount.
	useEffect(() => {
		void queryClient.invalidateQueries({ queryKey: pluginKeys.permissionRequests(pluginId) });
	}, [queryClient, pluginId]);

	// Once every request has been decided — here, on the grants tab, or by
	// another admin — the prompt has served its purpose. Only trust a list that
	// was fetched after mount and is not being refreshed: a cached empty list
	// would otherwise close the prompt before the new request ever shows up.
	const listIsCurrent = pendingQuery.isFetchedAfterMount && !pendingQuery.isFetching;
	useEffect(() => {
		if (listIsCurrent && pendingQuery.isSuccess && pendingRequests.length === 0) onClose([]);
	}, [listIsCurrent, pendingQuery.isSuccess, pendingRequests.length, onClose]);

	const decide = async (requestId: string, action: "approve" | "deny" | "denyPermanent") => {
		setBusy(true);
		try {
			if (action === "approve") {
				await pluginsApi.approveGrantRequest(pluginId, requestId);
			} else {
				await pluginsApi.denyGrantRequest(pluginId, requestId, {
					permanent: action === "denyPermanent",
				});
			}
			setError(null);
			invalidate();
		} catch (err) {
			setError(localizePluginError(err, t));
		} finally {
			setBusy(false);
		}
	};

	const dismiss = () => onClose(pendingRequests.map((request) => request.requestId));

	const openGrants = () => {
		dismiss();
		void navigate({ to: "/settings/plugins/$pluginId", params: { pluginId } });
	};

	return (
		<Modal
			opened
			onClose={dismiss}
			title={t("admin.permissionPrompt.title", { plugin: pluginName })}
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{t("admin.permissionPrompt.runtimeHint")}
				</Text>
				{error && (
					<Alert color="red" icon={<IconAlertCircle size={16} />}>
						{error}
					</Alert>
				)}
				{pendingRequests.map((request) => (
					<PendingRequestRow
						key={request.requestId}
						request={request}
						busy={busy}
						onApprove={(requestId) => void decide(requestId, "approve")}
						onDeny={(requestId) => void decide(requestId, "deny")}
						onDenyPermanent={(requestId) => void decide(requestId, "denyPermanent")}
					/>
				))}
				<Group justify="space-between" wrap="nowrap">
					<Button variant="subtle" size="compact-sm" onClick={openGrants}>
						{t("admin.permissionPrompt.openGrants")}
					</Button>
					<Button variant="default" size="compact-sm" onClick={dismiss}>
						{t("admin.permissionPrompt.later")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
