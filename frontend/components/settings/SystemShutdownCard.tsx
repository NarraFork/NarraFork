import { Alert, Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { ApiError, api } from "../../lib/api";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const queryKey = ["system-lifecycle"];

export function SystemShutdownCard() {
	const { data: user } = useCurrentUser();
	if (user?.role !== "admin") return null;
	return <AdminSystemShutdownCard />;
}

function AdminSystemShutdownCard() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const statusQuery = useQuery({
		queryKey,
		queryFn: ({ signal }) => api.getSystemLifecycleStatus(signal),
		enabled: (query) =>
			query.state.data?.phase !== "shutting_down" &&
			!(
				query.state.data?.shutdownRequested &&
				query.state.error &&
				!(query.state.error instanceof ApiError)
			),
		refetchInterval: (query) =>
			query.state.data?.phase === "shutting_down" ||
			(query.state.data?.shutdownRequested &&
				query.state.error &&
				!(query.state.error instanceof ApiError))
				? false
				: 2_000,
		// After shutdown is acknowledged, never mistake a reconnect for completion.
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: (query) => query.state.data?.phase !== "shutting_down",
		retry: false,
	});
	const action = useMutation({
		mutationFn: (kind: "prepare" | "shutdown" | "cancel") => {
			if (kind === "prepare") return api.prepareSystemRecovery();
			if (kind === "shutdown") return api.shutdownSystem();
			return api.cancelSystemRecovery();
		},
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey });
		},
		onSuccess: async (result) => {
			// A status request started during the action must not overwrite its result.
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData(queryKey, result.status);
		},
		retry: false,
	});
	const status = statusQuery.data;
	const shuttingDown = status?.phase === "shutting_down";
	const disconnected =
		!!status?.shutdownRequested && !!statusQuery.error && !(statusQuery.error instanceof ApiError);
	const busy =
		action.isPending ||
		confirming ||
		statusQuery.isLoading ||
		!status ||
		shuttingDown ||
		disconnected;
	const canPrepare = status?.phase === "idle" || status?.phase === "failed";
	const canCancel =
		status?.phase === "preparing" || status?.phase === "prepared" || status?.phase === "failed";
	const errors = [
		...new Set([
			action.error?.message,
			status?.error,
			disconnected ? undefined : statusQuery.error?.message,
		]),
	].filter(Boolean);
	const shutdown = async () => {
		setConfirming(true);
		try {
			const accepted = await confirm({
				title: t("systemShutdownConfirmTitle"),
				message: t("systemShutdownConfirmDescription"),
				confirmLabel: t("systemShutdownAction"),
				confirmColor: "red",
			});
			if (accepted) action.mutate("shutdown");
		} finally {
			setConfirming(false);
		}
	};
	return (
		<Paper p="sm" radius="sm" withBorder>
			<Stack gap="sm">
				<Group gap="xs">
					<Text fw={600} size="sm">
						{t("systemShutdownTitle")}
					</Text>
					{status && <Badge variant="light">{t(`systemLifecyclePhase_${status.phase}`)}</Badge>}
				</Group>
				<Text size="xs" c="dimmed">
					{t("systemShutdownDescription")}
				</Text>
				{statusQuery.isLoading && <Text size="sm">{t("systemLifecycleLoading")}</Text>}
				{errors.map((error) => (
					<Alert key={error} color="red">
						{error}
					</Alert>
				))}
				{disconnected && (
					<Alert color="yellow">
						{t("systemShutdownDisconnected")}
						<Text size="xs">{statusQuery.error?.message}</Text>
					</Alert>
				)}
				{status && (
					<Text size="xs" c="dimmed">
						{t("systemLifecycleCounts", {
							bash: status.coordination.pendingBackgroundBashCount,
							executions: status.coordination.pendingOrdinaryExecutionCount,
							resumable: status.coordination.resumableExecutionCount,
							paused: status.coordination.pausedToolCount,
							blockers: status.coordination.blockers.length,
						})}
					</Text>
				)}
				{status?.phase === "prepared" && !status.shutdownRequested && (
					<Alert color="blue">{t("systemRecoveryPrepared")}</Alert>
				)}
				{status?.shutdownRequested && !shuttingDown && (
					<Alert color="yellow">{t("systemShutdownQueued")}</Alert>
				)}
				{shuttingDown && <Alert color="yellow">{t("systemShutdownManualStart")}</Alert>}
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						disabled={busy || !canPrepare}
						loading={action.isPending && action.variables === "prepare"}
						onClick={() => action.mutate("prepare")}
					>
						{t("systemRecoveryPrepare")}
					</Button>
					<Button
						size="xs"
						color="red"
						disabled={busy || status?.shutdownRequested}
						loading={action.isPending && action.variables === "shutdown"}
						onClick={() => void shutdown()}
					>
						{t("systemShutdownAction")}
					</Button>
					{canCancel && (
						<Button
							size="xs"
							variant="subtle"
							disabled={busy}
							loading={action.isPending && action.variables === "cancel"}
							onClick={() => action.mutate("cancel")}
						>
							{t("systemRecoveryCancel")}
						</Button>
					)}
				</Group>
			</Stack>
		</Paper>
	);
}
